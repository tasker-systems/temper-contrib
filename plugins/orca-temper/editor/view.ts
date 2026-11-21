// The frame's drawing: a header naming the record, when its base was read and whether temper has
// moved past it; the difference between that base and the working text; then the working text
// rendered as temper-ui renders a body. DOM only — no `orca` global — so a test can draw it.
//
// The header carries Save — the one act that sends the working text to temper — what it
// answered, and a notice when the file on disk holds a local save temper does not have. A
// refused save draws the three versions (the base, the person's, temper's current) with
// carry-over, discard, and handing the disagreement to an agent.
//
// The body renders into its own shadow root: nothing a record carries can select the header,
// the "Behind" notice or the difference. The house theme's roles reach it by inheritance (they
// are custom properties set on the frame's root); the recipes it needs travel inside it.
import { BASE_CSS, DARK_THEME_CSS, LIGHT_THEME_CSS, MARKDOWN_CSS } from '../vendor/temper-design-frame.mjs'
import type { DiffLine } from './diff'
import { viewHandoffPrompt } from './handoff'
import { renderBody } from './render'
import { headerWords, type RoomState, type SaveState } from './room'

const FRAME_CSS = `
body { margin: 0; }
.room { box-sizing: border-box; min-height: 100vh; padding: 16px 24px 48px; max-width: 920px; }
.room-kind { font-family: var(--tp-font-doing); font-size: 0.62rem; text-transform: uppercase;
  letter-spacing: var(--tp-tracking-label); color: var(--tp-text-subtle); }
.room-title { font-family: var(--tp-font-reading); font-size: 1.4rem; font-weight: 400;
  color: var(--tp-text); margin: 4px 0 6px; }
.room-base { font-family: var(--tp-font-doing); font-size: 0.72rem; color: var(--tp-text-subtle); }
.room-fresh { font-size: 0.8rem; color: var(--tp-text-muted); margin: 4px 0 0; }
.room-header .ed-notice { margin: 8px 0 0; }
.room-changes { margin: 14px 0 0; border-top: 1px solid var(--tp-rule); padding-top: 10px; }
.room-changes summary { cursor: pointer; font-family: var(--tp-font-doing); font-size: 0.72rem;
  color: var(--tp-text-muted); }
.room-diff { margin: 8px 0 0; padding: 8px 0; overflow-x: auto; font: 0.78rem/1.5 var(--tp-font-doing);
  background: var(--tp-surface); border-radius: var(--tp-radius-chip); }
.room-diff div { white-space: pre-wrap; padding: 0 10px; color: var(--tp-text-subtle); }
.room-diff .added { background: var(--tp-success-wash); color: var(--tp-success); }
.room-diff .removed { background: var(--tp-danger-wash); color: var(--tp-danger); text-decoration: line-through; }
.room-diff .fold { color: var(--tp-text-faint); font-style: italic; }
.room-body { margin-top: 18px; border-top: 1px solid var(--tp-rule); }
.room-save { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; margin: 8px 0 0; }
.room-save-words { font-size: 0.8rem; color: var(--tp-text-muted); }
.room-stale { margin: 14px 0 0; }
.room-stale h2 { font-family: var(--tp-font-reading); font-weight: 400; font-size: 1.05rem; color: var(--tp-text); margin: 12px 0 6px; }
.room-version { margin: 6px 0 0; border-top: 1px solid var(--tp-rule); padding-top: 6px; }
.room-version summary { cursor: pointer; font-family: var(--tp-font-doing); font-size: 0.72rem; color: var(--tp-text-muted); }
.room-version pre { margin: 6px 0 0; padding: 8px 10px; white-space: pre-wrap; overflow-x: auto;
  font: 0.78rem/1.5 var(--tp-font-doing); color: var(--tp-text); background: var(--tp-surface);
  border-radius: var(--tp-radius-chip); }
.room-choices { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 10px 0 0; }
.room-handoff { margin: 10px 0 0; display: grid; gap: 6px; }
.room-handoff label { font-size: 0.8rem; color: var(--tp-text-muted); }
.room-handoff textarea, .room-handoff select { font: 0.85rem var(--tp-font-reading); color: var(--tp-text);
  background: var(--tp-surface); border: 1px solid var(--tp-rule); border-radius: var(--tp-radius-chip); padding: 6px 8px; }
.room-handoff textarea { min-height: 3.2em; resize: vertical; }
`

/** The frame document's own stylesheet: the contract's recipes, both house themes, the room. */
export const FRAME_STYLES = [BASE_CSS, DARK_THEME_CSS, LIGHT_THEME_CSS, FRAME_CSS].join('\n')

/** The body scope's one stylesheet: the recipes a rendered body reads (`.hljs`, `.md-body`). */
const BODY_STYLES = [BASE_CSS, MARKDOWN_CSS, ':host { display: block; }'].join('\n')

/** Kept lines shown around each change; longer unchanged runs fold. */
const CONTEXT = 2

export interface RoomViewDeps {
  /** Opens an http(s) link outside the frame. */
  openExternal(href: string): void
  /** The Save button. */
  save(): void
  /** After a refused save: carry the person's change onto the current version. */
  carryOver(): void
  /** After a refused save: drop the person's text for the current version. */
  discard(): void
  /** After a refused save: hand the three versions to `agent`, with the person's intent. */
  handOff(agent: string, intent: string): void
}

/** What the Save line says, by where the save stands. */
export function saveWords(save: SaveState): string | null {
  switch (save.kind) {
    case 'idle':
      return save.note
    case 'saving':
      return 'Saving to temper…'
    case 'saved':
      return `Saved to temper at ${save.at.slice(0, 16).replace('T', ' ')} UTC — the base is now the saved version.`
    case 'stale':
      return save.note ?? 'Not saved — temper has moved past this base since it was read, so nothing was written. The three versions are below.'
    case 'refused':
      return save.message
  }
}

/** Draws room states into `root`; the returned function redraws on each state. */
export function roomView(root: HTMLElement, deps: RoomViewDeps): (state: RoomState) => void {
  const doc = root.ownerDocument

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
    const node = doc.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  /** The difference, with unchanged runs longer than the context folded to a line that says so. */
  function diffBlock(lines: readonly DiffLine[]): HTMLElement {
    const block = element('div', 'room-diff')
    const near = lines.map((_, index) =>
      lines.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((line) => line.kind !== 'same')
    )
    let folded = 0
    const flush = () => {
      if (folded > 0) {
        block.append(element('div', 'fold', `… ${folded} unchanged line${folded === 1 ? '' : 's'}`))
        folded = 0
      }
    }
    lines.forEach((line, index) => {
      if (line.kind === 'same' && !near[index]) {
        folded++
        return
      }
      flush()
      const mark = line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '
      block.append(element('div', line.kind === 'same' ? '' : line.kind, `${mark}${line.text}`))
    })
    flush()
    return block
  }

  // Whether the person opened or closed the difference survives a redraw.
  let changesOpen = true

  function button(label: string, kind: 'primary' | 'ghost' | 'danger', enabled: boolean, act: () => void) {
    const node = element('button', `ed-action ed-action--${kind}`, label)
    node.type = 'button'
    node.disabled = !enabled
    node.addEventListener('click', () => {
      if (!node.disabled) act()
    })
    return node
  }

  function version(label: string, text: string): HTMLElement {
    const box = element('details', 'room-version')
    box.open = true
    box.append(element('summary', '', label), element('pre', '', text))
    return box
  }

  // Stable sections, so the refused save's intent box keeps what the person typed across the
  // redraws a check or a document causes; the body re-renders only when its text changes.
  const head = element('header', 'room-header')
  const stale = element('section', 'room-stale')
  const changesSlot = element('div', '')
  const host = element('div', 'room-body')
  const scope = host.attachShadow({ mode: 'open' })
  const sheet = doc.createElement('style')
  sheet.textContent = BODY_STYLES
  const rendered = element('div', 'md-body')
  scope.append(sheet, rendered)
  // Links in a body never navigate the frame: an http(s) link opens in the browser (Orca asks
  // the person first for a host the plugin was not allowed); anything else stays where it is.
  scope.addEventListener('click', (event) => {
    const link = (event.target as Element | null)?.closest?.('a')
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href)) deps.openExternal(href)
  })
  let renderedBody: string | null = null
  // The refused save drawn last, and the handoff inputs made for it.
  let staleDrawn: SaveState | null = null
  let handoffInputs: { versions: unknown; intent: HTMLTextAreaElement; agent: HTMLSelectElement } | null = null

  function drawStale(state: Extract<RoomState, { kind: 'record' }>): void {
    const save = state.save
    if (save === staleDrawn) return
    staleDrawn = save
    stale.replaceChildren()
    if (save.kind !== 'stale') {
      handoffInputs = null
      return
    }
    const { versions } = save
    stale.append(element('h2', '', 'Not saved — three versions'))
    const changed = versions.updatedAt ? `, changed ${versions.updatedAt.slice(0, 16).replace('T', ' ')} UTC` : ''
    stale.append(
      version('The base — what you started from', versions.base),
      version('Yours — the working text', versions.mine),
      version(`temper's current — read ${versions.currentReadAt.slice(0, 16).replace('T', ' ')} UTC${changed}`, versions.current)
    )
    const choices = element('div', 'room-choices')
    choices.append(
      button('Carry my change onto the current version', 'primary', !save.busy, deps.carryOver),
      button('Discard mine — take the current version', 'danger', !save.busy, deps.discard)
    )
    stale.append(choices)

    if (handoffInputs === null || handoffInputs.versions !== versions) {
      const intent = doc.createElement('textarea')
      intent.id = 'room-intent'
      const agent = doc.createElement('select')
      agent.id = 'room-agent'
      handoffInputs = { versions, intent, agent }
    }
    const { intent, agent } = handoffInputs
    const handoff = element('div', 'room-handoff')
    const intentLabel = element('label', '', 'Hand it to an agent here — what should it do? (optional)')
    intentLabel.htmlFor = 'room-intent'
    const preview = element('details', 'room-version')
    const previewText = element('pre', '')
    const held = state.base.kind === 'held' ? state.base.held : null
    const updatePreview = () => {
      previewText.textContent = held ? viewHandoffPrompt(intent.value, versions, state.view.header.title, held.path) : ''
    }
    intent.oninput = updatePreview
    updatePreview()
    preview.append(element('summary', '', 'What the agent is sent'), previewText)
    let canHand = !save.busy && held !== null
    if (save.agents.kind === 'ok' && save.agents.agents.length > 0) {
      const chosen = agent.value
      agent.replaceChildren(
        ...save.agents.agents.map((choice) => {
          const option = doc.createElement('option')
          option.value = choice.id
          option.textContent = choice.name
          return option
        })
      )
      const fallback = save.agents.agents.find((choice) => choice.isDefault) ?? save.agents.agents[0]
      agent.value = save.agents.agents.some((choice) => choice.id === chosen) ? chosen : (fallback?.id ?? '')
      handoff.append(intentLabel, intent, agent)
    } else {
      canHand = false
      const words =
        save.agents.kind === 'loading'
          ? 'Asking Orca which agents it can start…'
          : save.agents.kind === 'failed'
            ? `No agent can be offered: ${save.agents.message}`
            : 'Orca names no agent it can start here.'
      handoff.append(intentLabel, intent, element('p', 'room-save-words', words))
    }
    handoff.append(
      button('Hand to an agent', 'ghost', canHand, () => deps.handOff(agent.value, intent.value)),
      preview
    )
    stale.append(handoff)
  }

  return function draw(state: RoomState): void {
    if (state.kind === 'unreadable') {
      staleDrawn = null
      handoffInputs = null
      renderedBody = null
      root.replaceChildren(element('p', 'room-fresh', state.message))
      return
    }
    if (root.firstChild !== head) {
      root.replaceChildren(head, stale, changesSlot, host)
    }
    const { header, body } = state.view
    const words = headerWords(state)

    head.replaceChildren()
    head.append(element('div', 'room-kind', header.docType), element('h1', 'room-title', header.title))
    head.append(element('div', 'room-base', `${words.base} · edit in Orca's editor; only Save sends it to temper`))
    head.append(element('p', words.behind ? 'ed-notice' : 'room-fresh', words.freshness))
    if (words.local !== null) {
      head.append(element('p', 'ed-notice room-local', words.local))
    }
    const changed = state.base.kind === 'held' && (state.base.change.added > 0 || state.base.change.removed > 0)
    const canSave =
      state.base.kind === 'held' && changed && state.save.kind !== 'saving' && state.save.kind !== 'stale'
    const bar = element('div', 'room-save')
    bar.append(button('Save to temper', 'primary', canSave, deps.save))
    const said = saveWords(state.save)
    if (said !== null) bar.append(element('span', 'room-save-words', said))
    head.append(bar)

    drawStale(state)

    const changes = element('details', 'room-changes')
    changes.open = changesOpen
    changes.addEventListener('toggle', () => {
      changesOpen = changes.open
    })
    changes.append(element('summary', '', words.change))
    if (state.base.kind === 'held' && changed) {
      changes.append(diffBlock(state.base.change.lines))
    }
    changesSlot.replaceChildren(changes)

    if (renderedBody !== body) {
      renderedBody = body
      // renderBody is the sanitizer's output, <style> removed: the only HTML this frame ever sets.
      rendered.innerHTML = renderBody(body)
    }
  }
}
