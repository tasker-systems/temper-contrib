// The frame's drawing: a header naming the record, when its base was read and whether temper has
// moved past it; the difference between that base and the working text; then the working text
// rendered as temper-ui renders a body. DOM only — no `orca` global — so a test can draw it.
//
// The body renders into its own shadow root: nothing a record carries can select the header,
// the "Behind" notice or the difference. The house theme's roles reach it by inheritance (they
// are custom properties set on the frame's root); the recipes it needs travel inside it.
import { BASE_CSS, DARK_THEME_CSS, LIGHT_THEME_CSS, MARKDOWN_CSS } from '../vendor/temper-design-frame.mjs'
import type { DiffLine } from './diff'
import { renderBody } from './render'
import { headerWords, type RoomState } from './room'

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

  return function draw(state: RoomState): void {
    root.replaceChildren()
    if (state.kind === 'unreadable') {
      root.append(element('p', 'room-fresh', state.message))
      return
    }
    const { header, body } = state.view
    const words = headerWords(state)

    const head = element('header', 'room-header')
    head.append(element('div', 'room-kind', header.docType), element('h1', 'room-title', header.title))
    head.append(element('div', 'room-base', `${words.base} · this view edits nothing; Save arrives later`))
    head.append(element('p', words.behind ? 'ed-notice' : 'room-fresh', words.freshness))
    root.append(head)

    const changes = element('details', 'room-changes')
    changes.open = changesOpen
    changes.addEventListener('toggle', () => {
      changesOpen = changes.open
    })
    changes.append(element('summary', '', words.change))
    if (state.base.kind === 'held' && (state.base.change.added > 0 || state.base.change.removed > 0)) {
      changes.append(diffBlock(state.base.change.lines))
    }
    root.append(changes)

    const host = element('div', 'room-body')
    const scope = host.attachShadow({ mode: 'open' })
    const sheet = doc.createElement('style')
    sheet.textContent = BODY_STYLES
    const rendered = element('div', 'md-body')
    // renderBody is the sanitizer's output, <style> removed: the only HTML this frame ever sets.
    rendered.innerHTML = renderBody(body)
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
    root.append(host)
  }
}
