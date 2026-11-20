// The custom editor for `.temper.md` view files: a header naming the record and when its base
// was read, then the body, read-only. Colours are Orca's own `--orca-*` variables, so the frame
// follows the person's theme; no colour is literal here.
import { follow, readTimeWords, type EditorView } from './sync'

const root = document.createElement('main')
root.style.cssText =
  'box-sizing:border-box;min-height:100vh;margin:0;padding:16px 20px;' +
  'color:var(--orca-foreground);background:var(--orca-background);font:13px system-ui,sans-serif'
document.body.style.margin = '0'
document.body.append(root)

function draw(state: EditorView): void {
  root.replaceChildren()
  if (state.kind === 'unreadable') {
    const message = document.createElement('p')
    message.textContent = state.message
    root.append(message)
    return
  }
  const { header, body } = state.view

  const kind = document.createElement('div')
  kind.textContent = header.docType
  kind.style.cssText = 'font-size:11px;opacity:0.7'

  const title = document.createElement('h1')
  title.textContent = header.title
  title.style.cssText = 'font-size:18px;margin:4px 0'

  const base = document.createElement('div')
  base.textContent = `Base ${readTimeWords(header.readAt)} · read-only — editing and Save arrive later`
  base.style.cssText = 'font-size:11px;opacity:0.7;margin-bottom:12px'

  const text = document.createElement('pre')
  text.textContent = body
  text.style.cssText =
    'white-space:pre-wrap;word-wrap:break-word;margin:0;padding-top:12px;' +
    'border-top:1px solid var(--orca-border, currentColor);font:13px ui-monospace,monospace'

  root.append(kind, title, base, text)
}

follow(draw)
