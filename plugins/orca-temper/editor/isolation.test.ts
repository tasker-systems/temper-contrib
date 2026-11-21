// A body's own CSS never reaches the frame's chrome: a record that carries `<style>` (HTML, or
// inside an SVG) aimed at the header, the "Behind" notice and the difference leaves all three as
// they are, and no `<style>` survives into the rendered body. `the-base-is-stated` depends on it —
// a body that could hide the notice could make a behind view pass for current.
//
// Two layers hold it, and each has its own assertion. jsdom applies a shadow root's stylesheet to
// the whole document (a browser scopes it), so the computed-style test witnesses the stripping;
// the shadow root is witnessed by structure: the body lives only in its own scope.
import { JSDOM } from 'jsdom'
import { assert, test } from 'orca/testing'

// One window for every DOM test in this run: the sanitizer binds to the first window it sees.
const globals = globalThis as unknown as Record<string, unknown>
if (globals.document === undefined) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'Element', 'Node', 'DocumentFragment', 'NodeFilter', 'HTMLElement']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name]
  }
}
const frameWindow = globals.window as Window & typeof globalThis

const { diffLines } = await import('./diff')
const { renderBody } = await import('./render')
const { FRAME_STYLES, roomView } = await import('./view')
type RoomState = import('./room').RoomState

const BASE = '## Problem\n\nThe body, as temper stores it.\n'

const TARGETS = '.room, .room-header, header, .ed-notice, p, .room-changes, details, summary, .room-diff, .room-diff div'
const HIDE = `${TARGETS} { display: none !important; visibility: hidden !important; opacity: 0 !important; color: transparent !important; }`

/** A body whose author tries to hide the chrome — once as HTML, once inside an SVG. */
const HOSTILE = [
  BASE,
  'Looks current.',
  `<style>${HIDE}</style>`,
  `<svg width="10" height="10"><style>${HIDE}</style><circle r="4"></circle></svg>`,
  `<div><style>@import "x.css"; ${HIDE}</style></div>`
].join('\n\n')

const PROPERTIES = ['display', 'visibility', 'opacity', 'color'] as const

function behindState(body: string): RoomState {
  return {
    kind: 'record',
    view: {
      header: {
        id: '00000000-0000-7000-8000-0000000000f2',
        ref: 'the-body-room',
        title: 'The body room',
        docType: 'task',
        readAt: '2026-11-20T17:38:00Z',
        meta: {}
      },
      body
    },
    base: {
      kind: 'held',
      held: {
        id: '00000000-0000-7000-8000-0000000000f2',
        body_token: 'bt1.first',
        base: BASE,
        read_at: '2026-11-20T17:38:00Z',
        path: '/nowhere',
        workspaceId: 'fixture'
      },
      change: diffLines(BASE, body)
    },
    freshness: { kind: 'behind', checkedAt: '2026-11-20T17:52:00Z', updatedAt: '2026-11-20T17:45:00Z' }
  }
}

/** Draws a state in a fresh frame document and reads what the person would see of the chrome. */
function drawn(body: string) {
  const doc = frameWindow.document
  doc.head.replaceChildren()
  doc.body.replaceChildren()
  const style = doc.createElement('style')
  style.textContent = FRAME_STYLES
  doc.head.append(style)
  const root = doc.createElement('main')
  root.className = 'room'
  doc.body.append(root)
  roomView(root, { openExternal: () => {} })(behindState(body))

  const chrome = {
    header: root.querySelector('header'),
    notice: root.querySelector('.ed-notice'),
    difference: root.querySelector('.room-diff')
  }
  const seen: Record<string, Record<string, string>> = {}
  for (const [name, node] of Object.entries(chrome)) {
    assert.ok(node, `the ${name} is drawn`)
    const computed = frameWindow.getComputedStyle(node)
    seen[name] = Object.fromEntries(PROPERTIES.map((property) => [property, computed.getPropertyValue(property)]))
  }
  return { doc, root, chrome, seen }
}

test('a body’s <style>, HTML or SVG, leaves the header, the Behind notice and the difference as they are', () => {
  const plain = drawn(`${BASE}\nLooks current.\n`).seen
  const { doc, chrome, seen } = drawn(HOSTILE)

  assert.match(chrome.notice?.textContent ?? '', /^Behind/)
  assert.ok((chrome.difference?.textContent ?? '').length > 0)
  for (const name of Object.keys(plain)) {
    assert.deepEqual(seen[name], plain[name], `the ${name} is unstyled by the body`)
    assert.notEqual(seen[name]?.display, 'none', `the ${name} is not hidden`)
    assert.notEqual(seen[name]?.visibility, 'hidden', `the ${name} is visible`)
  }
  // The frame document holds the frame's one stylesheet and nothing the body brought.
  assert.equal(doc.querySelectorAll('style').length, 1, 'no body <style> reaches the frame document')
})

test('the rendered body keeps no <style> element, HTML or SVG', () => {
  const html = renderBody(HOSTILE)
  const parsed = new frameWindow.DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  assert.equal(parsed.querySelectorAll('style').length, 0)
  assert.ok(!/<style/i.test(html), 'no <style> in the rendered HTML')
  assert.ok(parsed.querySelector('svg circle'), 'the rest of the SVG survives')
  assert.match(parsed.body.textContent ?? '', /Looks current\./)

  const { root } = drawn(HOSTILE)
  const host = root.querySelector('.room-body')
  assert.ok(host, 'the body has its own host')
  const shadow = host.shadowRoot
  assert.ok(shadow, 'the body renders into its own shadow root')
  const bodyStyles = Array.from(shadow.querySelectorAll('style'))
  assert.equal(bodyStyles.length, 1, 'the body scope carries only the house recipe stylesheet')
  assert.ok(shadow.querySelector('.md-body h2'), 'the body still renders')
  assert.equal(root.querySelector('.md-body'), null, 'no body markup sits in the frame document')
  assert.equal(host.childNodes.length, 0, 'the host holds nothing outside its scope')
})
