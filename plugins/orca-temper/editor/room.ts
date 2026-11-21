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
//
// Save is the one act that reaches temper: `save()` sends the working text to the worker's
// `temper.body.save`, guarded on the held base's token. A local save (the file written on disk by
// Orca's editor or an agent) reaches temper never; the worker's `temper.body.local` reads the
// file, and the header says when it holds a body temper does not. A refused save holds the three
// versions and offers carry-over, discard, or handing the disagreement to an agent.
import type {
  BaseCheckOutput,
  HandoffPlaceOutput,
  HeldBase,
  LocalSaveOutput,
  RebaseOutput,
  SaveOutput,
  StaleVersions
} from '../src/editor-room/protocol'
import type { LaunchAgentsOutput, LaunchAgentChoice, LaunchInput, LaunchOutput } from '../src/protocol'
import { changeWords, diffLines, type LineDiff } from './diff'
import { viewHandoffPrompt } from './handoff'
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

/** Whether the file on disk holds a local save temper does not have. */
export type LocalState =
  | { kind: 'unknown' }
  | { kind: 'clean' }
  | { kind: 'saved-locally'; savedAt: string }

/** The agents a refused save may be handed to, once asked. */
export type AgentChoices =
  | { kind: 'loading' }
  | { kind: 'ok'; agents: LaunchAgentChoice[] }
  | { kind: 'failed'; message: string }

/** Where the view's Save stands. */
export type SaveState =
  | { kind: 'idle'; note: string | null }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string }
  /** temper had moved past the base: nothing was written; the three versions are held. */
  | { kind: 'stale'; versions: StaleVersions; agents: AgentChoices; busy: boolean; note: string | null }
  | { kind: 'refused'; message: string }

export type RoomState =
  | { kind: 'unreadable'; message: string }
  | {
      kind: 'record'
      view: ParsedView
      /** The working text, whole: what Save sends. */
      text: string
      base: BaseState
      freshness: Freshness
      local: LocalState
      save: SaveState
    }

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
  /** The worker's `temper.body.local`: reads the view file only. */
  local(id: string): Promise<LocalSaveOutput>
  /** The worker's `temper.body.save`: the one act that writes to temper. */
  save(id: string, text: string): Promise<SaveOutput>
  /** The worker's `temper.body.rebase`. */
  rebase(id: string, discard: boolean): Promise<RebaseOutput>
  /** The worker's `temper.body.handoff-place`: the view workspace's project and the absolute view path. */
  place(workspaceId: string, path: string): Promise<HandoffPlaceOutput>
  /** The launcher's `temper.launch.agents`. */
  agents(): Promise<LaunchAgentsOutput>
  /** The launcher's `temper.launch.go`. */
  launch(input: LaunchInput): Promise<LaunchOutput>
}

export interface Room {
  /** Asks the worker again — the tab was focused. */
  recheck(): Promise<void>
  /** Save: the working text to temper, guarded on the held base. */
  save(): Promise<void>
  /** After a refused save: the current version becomes the base; the working text stays. */
  carryOver(): Promise<void>
  /** After a refused save: the person's text is dropped for the current version. */
  discard(): Promise<void>
  /**
   * After a refused save: carries over, then hands the three versions to an agent started in a
   * new workspace of the view's project; it writes its proposal into this view's file.
   */
  handOff(agent: string, intent: string): Promise<void>
  dispose(): void
}

/** The words a save that could not be sent shows. */
function saveFailureWords(answer: Exclude<SaveOutput, { state: 'saved' } | { state: 'stale' }>): string {
  switch (answer.state) {
    case 'not-connected':
      return `Not saved — ${answer.message}`
    case 'failed':
      return `Not saved — ${answer.message}`
    default:
      return answer.message
  }
}

const NO_BASE_WORDS =
  'Not saved — no base is held for this record here, so a save could not say which version it replaces. Open it again from the Temper rail.'

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

  // The local-save check reads the file only; it runs on every document and with each check.
  const checkLocal = async (): Promise<void> => {
    if (state === null || state.kind !== 'record') return
    const id = state.view.header.id
    let local: LocalState
    try {
      const answer = await deps.local(id)
      local =
        answer.state === 'saved-locally'
          ? { kind: 'saved-locally', savedAt: answer.savedAt }
          : answer.state === 'clean'
            ? { kind: 'clean' }
            : { kind: 'unknown' }
    } catch {
      local = { kind: 'unknown' }
    }
    if (state !== null && state.kind === 'record' && state.view.header.id === id) {
      emit({ ...state, local })
    }
  }

  /** Re-reads the held base after the worker moved it, and redraws the difference against it. */
  const reloadHeld = async (): Promise<HeldBase | null> => {
    if (state === null || state.kind !== 'record') return null
    const id = state.view.header.id
    let held: HeldBase | null
    try {
      held = await deps.held(id)
    } catch {
      held = null
    }
    if (state === null || state.kind !== 'record' || state.view.header.id !== id) return held
    emit({
      ...state,
      base: held === null ? { kind: 'missing' } : { kind: 'held', held, change: diffLines(held.base, state.view.body) }
    })
    return held
  }

  const save = async (): Promise<void> => {
    if (state === null || state.kind !== 'record' || state.save.kind === 'saving') return
    // No held base: refused here, before the worker — and the worker refuses it again itself.
    if (state.base.kind !== 'held') {
      emit({ ...state, save: { kind: 'refused', message: NO_BASE_WORDS } })
      return
    }
    const id = state.view.header.id
    const text = state.text
    emit({ ...state, save: { kind: 'saving' } })
    let answer: SaveOutput
    try {
      answer = await deps.save(id, text)
    } catch (error) {
      answer = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
    if (state === null || state.kind !== 'record' || state.view.header.id !== id) return
    switch (answer.state) {
      case 'saved': {
        emit({ ...state, save: { kind: 'saved', at: answer.readAt }, freshness: { kind: 'current', checkedAt: answer.readAt } })
        await reloadHeld()
        await checkLocal()
        return
      }
      case 'stale': {
        const { state: _stale, ...versions } = answer
        emit({
          ...state,
          save: { kind: 'stale', versions, agents: { kind: 'loading' }, busy: false, note: null },
          freshness: { kind: 'behind', checkedAt: answer.currentReadAt, updatedAt: answer.updatedAt }
        })
        let agents: AgentChoices
        try {
          const listed = await deps.agents()
          agents = listed.state === 'ok' ? { kind: 'ok', agents: listed.agents } : { kind: 'failed', message: listed.message }
        } catch (error) {
          agents = { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
        }
        if (state !== null && state.kind === 'record' && state.save.kind === 'stale') {
          emit({ ...state, save: { ...state.save, agents } })
        }
        return
      }
      case 'no-base':
        emit({ ...state, save: { kind: 'refused', message: NO_BASE_WORDS } })
        return
      default:
        emit({ ...state, save: { kind: 'refused', message: saveFailureWords(answer) } })
    }
  }

  /** Moves the held base onto the refused save's current version; answers whether it moved. */
  const moveOnto = async (discard: boolean): Promise<boolean> => {
    if (state === null || state.kind !== 'record' || state.save.kind !== 'stale' || state.save.busy) return false
    const id = state.view.header.id
    emit({ ...state, save: { ...state.save, busy: true, note: null } })
    let answer: RebaseOutput
    try {
      answer = await deps.rebase(id, discard)
    } catch (error) {
      answer = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
    if (state === null || state.kind !== 'record' || state.save.kind !== 'stale') return false
    if (answer.state !== 'rebased') {
      emit({ ...state, save: { ...state.save, busy: false, note: answer.message } })
      return false
    }
    await reloadHeld()
    return true
  }

  const carryOver = async (): Promise<void> => {
    if (await moveOnto(false)) {
      if (state === null || state.kind !== 'record') return
      emit({
        ...state,
        save: {
          kind: 'idle',
          note: "Your text is now worked against temper's current version — the difference shows what differs from it. Reconcile it, then Save."
        },
        freshness: { kind: 'checking' }
      })
      await recheck()
      await checkLocal()
    }
  }

  const discard = async (): Promise<void> => {
    if (await moveOnto(true)) {
      if (state === null || state.kind !== 'record') return
      emit({
        ...state,
        save: { kind: 'idle', note: "Your text was dropped: the view now holds temper's current version." },
        freshness: { kind: 'checking' }
      })
      await recheck()
      await checkLocal()
    }
  }

  const handOff = async (agent: string, intent: string): Promise<void> => {
    if (state === null || state.kind !== 'record' || state.save.kind !== 'stale' || state.base.kind !== 'held') return
    const { versions } = state.save
    const { header } = state.view
    const held = state.base.held
    // Where the agent starts (ruling 25): a new workspace in the view workspace's project, and
    // the view file by its absolute path. A place that cannot be named starts nothing and
    // moves nothing.
    let place: HandoffPlaceOutput
    try {
      place = await deps.place(held.workspaceId, held.path)
    } catch (error) {
      place = { state: 'refused', message: error instanceof Error ? error.message : String(error) }
    }
    if (place.state !== 'ok') {
      if (state === null || state.kind !== 'record' || state.save.kind !== 'stale') return
      emit({ ...state, save: { ...state.save, note: `The agent did not start: ${place.message}` } })
      return
    }
    const prompt = viewHandoffPrompt(intent, versions, header.title, place.path)
    // The agent reconciles onto the current version, so the view moves onto it first.
    if (!(await moveOnto(false))) return
    let launched: LaunchOutput
    try {
      launched = await deps.launch({
        destination: 'new-workspace',
        projectId: place.projectId,
        agent,
        prompt,
        item: { id: header.id, ref: header.ref, title: header.title, contextRef: null }
      })
    } catch (error) {
      launched = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
    if (state === null || state.kind !== 'record') return
    const note =
      launched.state === 'launched'
        ? `Handed to ${agent}, started in a new workspace, ${launched.workspaceName ?? launched.workspaceId}, beside ${place.workspace}. Its proposal will appear in this view's difference, against temper's current version: review it, then Save.`
        : `Your text is now worked against temper's current version, but the agent did not start: ${launched.message}`
    emit({ ...state, save: { kind: 'idle', note }, freshness: { kind: 'checking' } })
    await recheck()
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
    const local: LocalState = sameRecord ? previous.local : { kind: 'unknown' }
    // A saved notice holds only while the text is what was saved.
    const save: SaveState = !sameRecord
      ? { kind: 'idle', note: null }
      : previous.save.kind === 'saved' && previous.text !== document.content.text
        ? { kind: 'idle', note: null }
        : previous.save
    emit({ kind: 'record', view, text: document.content.text, base, freshness, local, save })

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
      void checkLocal()
      if (!sameRecord || baseMoved) {
        await recheck()
      }
    })()
  })

  const stopTicking = deps.every(CHECK_INTERVAL_MS, () => {
    void recheck()
    void checkLocal()
  })

  return {
    async recheck() {
      await Promise.all([recheck(), checkLocal()])
    },
    save,
    carryOver,
    discard,
    handOff,
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
  /** Set when the file on disk holds a local save temper does not have. */
  local: string | null
}

function clock(at: string): string {
  return readTimeWords(at).replace(/^read /, '')
}

/** The local-save notice: a save on disk is never a save to temper, and the view says so. */
export function localWords(local: LocalState): string | null {
  return local.kind === 'saved-locally'
    ? `Saved locally ${clock(local.savedAt)} — that save did not reach temper. Only Save sends this text to temper.`
    : null
}

export function headerWords(state: Extract<RoomState, { kind: 'record' }>): HeaderWords {
  const local = localWords(state.local)
  return { ...freshnessWords(state), local }
}

function freshnessWords(state: Extract<RoomState, { kind: 'record' }>): Omit<HeaderWords, 'local'> {
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
