// The custom editor for `.temper.md` view files: a header naming the record, when its base was
// read and whether temper has moved past it; the difference between that base and the working
// text, as it happens; then the working text rendered as temper-ui renders a body. The frame
// paints with temper-design's roles: the contract's stylesheets and the house theme matching
// Orca's light or dark, all from the vendored package — no colour is literal here.
//
// This view edits nothing. Editing happens in Orca's own editor of the same file (the toolbar
// switches to it), or on disk by an agent; each change reaches this frame through
// `orca.document.onDidChange` and redraws the difference.
import { heldBaseKey, type HeldBase } from '../src/editor-room/protocol'
import { THEMES } from '../vendor/temper-design-frame.mjs'
import { openRoom } from './room'
import { FRAME_STYLES, roomView } from './view'

const style = document.createElement('style')
style.textContent = FRAME_STYLES
document.head.append(style)

/** The house theme for Orca's light or dark, by the package's own index. */
function applyTheme(scheme: 'light' | 'dark'): void {
  const theme = THEMES.find((entry) => entry.appearance === scheme) ?? THEMES[0]
  if (theme) {
    document.documentElement.dataset.theme = theme.name
  }
}
applyTheme(document.documentElement.classList.contains('light') ? 'light' : 'dark')
orca.on('theme', (theme) => applyTheme(theme.colorScheme))

const root = document.createElement('main')
root.className = 'room'
document.body.append(root)
const draw = roomView(root, { openExternal: (href) => void orca.shell?.openExternal(href) })

const documentApi = orca.document
if (!documentApi) {
  throw new Error('this file runs as a custom editor')
}
const room = openRoom(
  {
    document: documentApi,
    held: async (id) => (await orca.storage.get(heldBaseKey(id))) as HeldBase | null,
    check: (id) => orca.plugin.request('temper.body.base', { id }),
    every: (ms, tick) => {
      const timer = setInterval(tick, ms)
      return () => clearInterval(timer)
    }
  },
  draw
)

// Focus asks again: the person looking at the tab is when "behind" matters most.
window.addEventListener('focus', () => void room.recheck())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void room.recheck()
})
