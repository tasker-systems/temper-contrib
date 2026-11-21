// The custom editor draws from the document: the record's title, the time its base was read and
// the body, from what the worker wrote; a file that does not say which record it is is never
// shown as one; an outside write redraws; and the editor posts no edit.
import { assert, mockEditorHost, test } from 'orca/testing'
import type { HeldBase } from '../src/editor-room/protocol'
import { openRoom, type RoomState } from './room'
import { readTimeWords, UNREADABLE_MESSAGE } from './sync'
import { composeViewFile } from './view-file'

const HEADER = {
  id: '00000000-0000-7000-8000-0000000000f1',
  ref: 'the-body-room-00000000-0000-7000-8000-0000000000f1',
  title: 'The body room',
  docType: 'task',
  readAt: '2026-11-20T17:38:00.000Z',
  meta: { 'temper-stage': 'in-progress' }
}
const BODY = '## Problem\n\n---\n\nA rule inside the body is the body, not frontmatter.\n'
const HELD: HeldBase = {
  id: HEADER.id,
  body_token: 'bt1.first',
  base: BODY,
  read_at: HEADER.readAt,
  path: '/nowhere',
  workspaceId: 'w'
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function follow(text: string) {
  const host = mockEditorHost({ text })
  const drawn: RoomState[] = []
  const document = host.orca.document
  if (!document) throw new Error('no document')
  const room = openRoom(
    {
      document,
      held: async () => HELD,
      check: async () => ({ state: 'current', readAt: HELD.read_at, checkedAt: HELD.read_at }),
      every: () => () => undefined,
      local: async () => ({ state: 'clean' }),
      save: async () => ({ state: 'failed', message: 'this test saves nothing' }),
      rebase: async () => ({ state: 'failed', message: 'this test rebases nothing' }),
      agents: async () => ({ state: 'ok', agents: [] }),
      launch: async () => ({ state: 'failed', message: 'this test launches nothing' })
    },
    (state) => drawn.push(state)
  )
  return { host, drawn, room }
}

test('the editor draws the body and the read time from a document', async () => {
  const { host, drawn, room } = follow(composeViewFile(HEADER, BODY))
  await settle()
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
  await settle()
  const last = drawn[drawn.length - 1]
  assert.equal(last?.kind === 'record' ? last.view.body.endsWith("An agent's line.\n") : false, true)

  assert.equal(host.edits.length, 0, 'the editor posts no edit')
  room.dispose()
  host.dispose()
})

test('a file without the frontmatter is not shown as a record', async () => {
  const { host, drawn, room } = follow('# just markdown\n')
  await settle()
  assert.deepEqual(drawn[0], { kind: 'unreadable', message: UNREADABLE_MESSAGE })
  room.dispose()
  host.dispose()
})
