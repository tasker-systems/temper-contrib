// The custom editor's state, without a DOM: what the tab knows about its record and how it says
// it. Three things feed it:
//
//   - the document — `orca.document.onDidChange` replays the current file, then each change Orca
//     sends from outside the frame (an edit in Orca's own editor of the same file, an agent writing
//     it on disk). The view's body is the working text.
//   - the held base — read from the plugin's storage on every document, so a reopen from the rail
//     is picked up. The difference is the held base against the working text, recomputed each time.
//   - the base check — the worker's `temper.body.base`, asked on open, when the tab is focused, and
//     every CHECK_INTERVAL_MS. Until it answers, and when it cannot, the header never says current.
//
// The room posts nothing to the document: editing happens in Orca's own editor of the same file
// (see the session record on where editing happens), and this view shows base and difference.
import type { BaseCheckOutput, HeldBase } from '../src/editor-room/protocol'
import { changeWords, diffLines, type LineDiff } from './diff'
import { readTimeWords, UNREADABLE_MESSAGE } from './sync'
import { parseViewFile, type ParsedView } from './view-file'

/** No tighter than a minute: a check is one body read on the person's grant. */
export const CHECK_INTERVAL_MS = 60_000

/** Whether temper has moved past the held base, as the last check answered. */
export type Freshness =
  | { kind: 'checking' }
  | { kind: 'current'; checkedAt: string }
  | { kind: 'behind'; checkedAt: string; updatedAt: string | null }
  | { kind: 'unknown'; message: string }

export type BaseState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'held'; held: HeldBase; change: LineDiff }

export type RoomState =
  | { kind: 'unreadable'; message: string }
  | { kind: 'record'; view: ParsedView; base: BaseState; freshness: Freshness }

/** The document as the frame hears it; `orca.document` in the frame, a mock in tests. */
export interface RoomDocument {
  onDidChange(handler: (document: { content: { kind: 'text'; text: string } | { kind: 'bytes' } }) => void): {
    dispose(): void
  }
}

export interface RoomDeps {
  document: RoomDocument
  /** The held base for a record, from the plugin's storage. */
  held(id: string): Promise<HeldBase | null>
  /** The worker's `temper.body.base`. */
  check(id: string): Promise<BaseCheckOutput>
  /** Runs `tick` every `ms`; answers how to stop. */
  every(ms: number, tick: () => void): () => void
}

export interface Room {
  /** Asks the worker again — the tab was focused. */
  recheck(): Promise<void>
  dispose(): void
}

function freshnessOf(answer: BaseCheckOutput): Freshness {
  switch (answer.state) {
    case 'current':
      return { kind: 'current', checkedAt: answer.checkedAt }
    case 'behind':
      return { kind: 'behind', checkedAt: answer.checkedAt, updatedAt: answer.updatedAt }
    default:
      return { kind: 'unknown', message: answer.message }
  }
}

/** Follows the document, the held base and the base check, drawing each new state. */
export function openRoom(deps: RoomDeps, draw: (state: RoomState) => void): Room {
  let state: RoomState | null = null
  let disposed = false
  // Each document bumps this; an answer for an older document is dropped.
  let generation = 0
  let checking: Promise<void> | null = null

  const emit = (next: RoomState) => {
    if (disposed) return
    state = next
    draw(next)
  }

  // One check in flight at a time; a check asked for meanwhile (a focus, a reopen's new base)
  // runs once more after it, so an answer about an older base is never the last word.
  let again = false
  const recheck = async (): Promise<void> => {
    if (state === null || state.kind !== 'record') return
    if (checking !== null) {
      again = true
      return checking
    }
    const id = state.view.header.id
    checking = (async () => {
      let freshness: Freshness
      try {
        freshness = freshnessOf(await deps.check(id))
      } catch (error) {
        freshness = { kind: 'unknown', message: error instanceof Error ? error.message : String(error) }
      }
      if (state !== null && state.kind === 'record' && state.view.header.id === id) {
        emit({ ...state, freshness })
      }
    })().finally(() => {
      checking = null
      if (again && !disposed) {
        again = false
        void recheck()
      }
    })
    return checking
  }

  const following = deps.document.onDidChange((document) => {
    const mine = ++generation
    if (document.content.kind !== 'text') {
      emit({ kind: 'unreadable', message: UNREADABLE_MESSAGE })
      return
    }
    const view = parseViewFile(document.content.text)
    if (view === null) {
      emit({ kind: 'unreadable', message: UNREADABLE_MESSAGE })
      return
    }
    const previous = state
    const sameRecord = previous !== null && previous.kind === 'record' && previous.view.header.id === view.header.id
    const freshness: Freshness = sameRecord ? previous.freshness : { kind: 'checking' }
    const base: BaseState = sameRecord && previous.base.kind === 'held'
      ? { kind: 'held', held: previous.base.held, change: diffLines(previous.base.held.base, view.body) }
      : { kind: 'loading' }
    emit({ kind: 'record', view, base, freshness })

    void (async () => {
      let held: HeldBase | null
      try {
        held = await deps.held(view.header.id)
      } catch {
        held = null
      }
      if (mine !== generation || state === null || state.kind !== 'record') return
      const nextBase: BaseState =
        held === null ? { kind: 'missing' } : { kind: 'held', held, change: diffLines(held.base, view.body) }
      // A reopen holds a new base: what the last check said was about the old one.
      const baseMoved =
        held !== null && previous !== null && previous.kind === 'record' && previous.base.kind === 'held' &&
        previous.base.held.body_token !== held.body_token
      emit({ ...state, base: nextBase, freshness: baseMoved ? { kind: 'checking' } : state.freshness })
      if (!sameRecord || baseMoved) {
        await recheck()
      }
    })()
  })

  const stopTicking = deps.every(CHECK_INTERVAL_MS, () => {
    void recheck()
  })

  return {
    recheck,
    dispose() {
      disposed = true
      following.dispose()
      stopTicking()
    }
  }
}

/** The header's words: the record, the base and whether temper has moved past it. */
export interface HeaderWords {
  /** "Base read 2026-11-20 17:38 UTC". */
  base: string
  /** Whether temper has moved past the base, plainly; never "current" unless a check said so. */
  freshness: string
  /** True when the view must not be taken for the current record. */
  behind: boolean
  /** The difference from the base, in words. */
  change: string
}

function clock(at: string): string {
  return readTimeWords(at).replace(/^read /, '')
}

export function headerWords(state: Extract<RoomState, { kind: 'record' }>): HeaderWords {
  const readAt = state.base.kind === 'held' ? state.base.held.read_at : state.view.header.readAt
  const base = `Base ${readTimeWords(readAt)}`
  if (state.base.kind === 'missing') {
    return {
      base,
      freshness: 'No base is held for this record here, so this view is not known to be current. Open it again from the Temper rail.',
      behind: true,
      change: 'The difference from the base is not known'
    }
  }
  const change = state.base.kind === 'held' ? changeWords(state.base.change) : 'Reading the held base…'
  switch (state.freshness.kind) {
    case 'checking':
      return { base, freshness: 'Checking whether temper has moved past this base…', behind: false, change }
    case 'current':
      return {
        base,
        freshness: `Current — temper had not moved past this base when checked at ${clock(state.freshness.checkedAt)}`,
        behind: false,
        change
      }
    case 'behind': {
      const changed = state.freshness.updatedAt ? `, changed ${clock(state.freshness.updatedAt)}` : ''
      return {
        base,
        freshness: `Behind — temper has moved past this base${changed} (checked ${clock(state.freshness.checkedAt)}). This view is not the current record.`,
        behind: true,
        change
      }
    }
    case 'unknown':
      return {
        base,
        freshness: `Not known whether temper has moved past this base: ${state.freshness.message}`,
        behind: false,
        change
      }
  }
}
