// The custom editor for `.temper.md` view files: a header naming the record, when its base was
// read and whether temper has moved past it; the difference between that base and the working
// text, as it happens; then the working text rendered as temper-ui renders a body. The frame
// paints with temper-design's roles: the contract's stylesheets and the house theme matching
// Orca's light or dark, all from the vendored package — no colour is literal here.
//
// This view edits nothing. Editing happens in Orca's own editor of the same file (the toolbar
// switches to it), or on disk by an agent; each change reaches this frame through
// `orca.document.onDidChange` and redraws the difference. Its Save is the one act that sends the
// working text to temper; a local file save never does, and the header says so.
import { heldBaseKey, type HeldBase } from '../src/editor-room/protocol'
import { THEMES } from '../vendor/temper-design-frame.mjs'
import { openRoom, type Room } from './room'
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

const documentApi = orca.document
if (!documentApi) {
  throw new Error('this file runs as a custom editor')
}
// The view's buttons act on the room; the drawing never reaches the worker itself. The room is
// made after the view, because its first document may draw at once.
let room: Room | null = null
const draw = roomView(root, {
  openExternal: (href) => void orca.shell?.openExternal(href),
  save: () => void room?.save(),
  carryOver: () => void room?.carryOver(),
  discard: () => void room?.discard(),
  handOff: (agent, intent) => void room?.handOff(agent, intent)
})
room = openRoom(
  {
    document: documentApi,
    held: async (id) => (await orca.storage.get(heldBaseKey(id))) as HeldBase | null,
    check: (id) => orca.plugin.request('temper.body.base', { id }),
    every: (ms, tick) => {
      const timer = setInterval(tick, ms)
      return () => clearInterval(timer)
    },
    local: (id) => orca.plugin.request('temper.body.local', { id }),
    save: (id, text) => orca.plugin.request('temper.body.save', { id, text }),
    rebase: (id, discard) => orca.plugin.request('temper.body.rebase', { id, discard }),
    agents: () => orca.plugin.request('temper.launch.agents'),
    launch: (input) => orca.plugin.request('temper.launch.go', input)
  },
  draw
)
const opened = room

// Focus asks again: the person looking at the tab is when "behind" matters most.
window.addEventListener('focus', () => void opened.recheck())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void opened.recheck()
})
