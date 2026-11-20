// The custom editor's only conversation with Orca: it listens to the document and hands each
// one on as a view of the record — never an edit. Editing, the difference against the held base
// and Save are later clauses; until then the editor draws the body read-only, whatever the
// document's own read-only flag says, and posts nothing back.
import { parseViewFile, type ParsedView } from './view-file'

/** What the editor draws for one document: the record, or why it cannot be shown as one. */
export type EditorView =
  | { kind: 'record'; view: ParsedView }
  | { kind: 'unreadable'; message: string }

export const UNREADABLE_MESSAGE =
  'This file does not say which temper record it is or when its base was read, so it is not shown as one. Open the record again from the Temper rail.'

export function viewOf(text: string): EditorView {
  const view = parseViewFile(text)
  return view === null ? { kind: 'unreadable', message: UNREADABLE_MESSAGE } : { kind: 'record', view }
}

/**
 * Replays the current document, then each one Orca sends when the file changes outside (an
 * agent's write included), as an EditorView.
 */
export function follow(draw: (view: EditorView) => void): { dispose(): void } {
  const document = orca.document
  if (!document) {
    throw new Error('this file runs as a custom editor')
  }
  return document.onDidChange((doc) => {
    if (doc.content.kind !== 'text') {
      draw({ kind: 'unreadable', message: UNREADABLE_MESSAGE })
      return
    }
    draw(viewOf(doc.content.text))
  })
}

/** "read 2026-11-20 17:38 UTC" — the base's read time, stated exactly, never relative. */
export function readTimeWords(readAt: string): string {
  const at = new Date(readAt)
  if (Number.isNaN(at.getTime())) {
    return `read ${readAt}`
  }
  return `read ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
