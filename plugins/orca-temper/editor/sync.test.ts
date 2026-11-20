// The custom editor draws from the document alone: the record's title, the time its base was
// read and the body, from what the worker wrote; a file that does not say which record it is
// is never shown as one; an outside write redraws; and the editor posts no edit.
import { assert, mockEditorHost, test } from 'orca/testing'
import { composeViewFile } from './view-file'
import { follow, readTimeWords, UNREADABLE_MESSAGE, type EditorView } from './sync'

const HEADER = {
  id: '00000000-0000-7000-8000-0000000000f1',
  ref: 'the-body-room-00000000-0000-7000-8000-0000000000f1',
  title: 'The body room',
  docType: 'task',
  readAt: '2026-11-20T17:38:00.000Z',
  meta: { 'temper-stage': 'in-progress' }
}
const BODY = '## Problem\n\n---\n\nA rule inside the body is the body, not frontmatter.\n'

test('the editor draws the body and the read time from a document', async () => {
  const host = mockEditorHost({ text: composeViewFile(HEADER, BODY) })
  const drawn: EditorView[] = []
  const following = follow((view) => drawn.push(view))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const first = drawn[0]
  assert.ok(first, 'the current document is drawn')
  assert.equal(first.kind, 'record')
  if (first.kind !== 'record') return
  assert.equal(first.view.header.title, 'The body room')
  assert.equal(first.view.header.readAt, HEADER.readAt)
  assert.equal(first.view.body, BODY)
  assert.equal(readTimeWords(first.view.header.readAt), 'read 2026-11-20 17:38 UTC')

  // An outside write (an agent's) redraws without reopening.
  host.replace(composeViewFile(HEADER, `${BODY}An agent's line.\n`))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const last = drawn[drawn.length - 1]
  assert.equal(last?.kind === 'record' ? last.view.body.endsWith("An agent's line.\n") : false, true)

  assert.equal(host.edits.length, 0, 'read-only: the editor posts no edit')
  following.dispose()
  host.dispose()
})

test('a file without the frontmatter is not shown as a record', async () => {
  const host = mockEditorHost({ text: '# just markdown\n' })
  const drawn: EditorView[] = []
  const following = follow((view) => drawn.push(view))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(drawn[0], { kind: 'unreadable', message: UNREADABLE_MESSAGE })
  following.dispose()
  host.dispose()
})
