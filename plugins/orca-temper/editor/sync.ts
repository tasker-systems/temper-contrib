// How the custom editor reads one document as a record, and states a read time. The room
// (`room.ts`) follows the document; this is what it makes of each one.
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

/** "read 2026-11-20 17:38 UTC" — the base's read time, stated exactly, never relative. */
export function readTimeWords(readAt: string): string {
  const at = new Date(readAt)
  if (Number.isNaN(at.getTime())) {
    return `read ${readAt}`
  }
  return `read ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
