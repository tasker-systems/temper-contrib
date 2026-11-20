// The editor room's live view, end to end in Node: the worker opens a record's body (a real git
// worktree, the host mock, deps standing in for the CLI and temper), then the custom editor's
// room follows that view file through `mockEditorHost`, reading the held base from the same
// plugin storage and asking the same worker whether temper has moved past it.
//
// Witnesses, first: `orca_view_says_when_its_base_is_behind` (the-base-is-stated) and
// `orca_view_shows_every_change_from_its_base` (every-change-is-in-view).
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, mockEditorHost, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { deps } from '../src/deps'
import { roomDeps } from '../src/editor-room/deps'
import { heldBaseKey, type HeldBase } from '../src/editor-room/protocol'
import * as main from '../src/worker'
import { CHECK_INTERVAL_MS, headerWords, openRoom, type Room, type RoomState } from './room'

const RECORD_ID = '00000000-0000-7000-8000-0000000000f1'
const RECORD_REF = `the-body-room-${RECORD_ID}`
const BODY = '## Problem\n\nThe body, as temper stores it.\n\n## What to build\n\nOne press.\n'
const OPENED_AT = new Date('2026-11-20T17:38:00Z')
const CHECKED_AT = new Date('2026-11-20T17:52:00Z')
const WORKSPACE_ID = 'fixture-repo::linked'

function fakeToken(expiresAtSeconds: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'none' })}.${encode({ exp: expiresAtSeconds })}.sig`
}
const TOKEN = fakeToken(4_102_444_800)

/** What temper holds now; a test changes it to stand in for another writer. */
const temper = { body: BODY, token: 'bt1.first', updated: '2026-11-20T01:00:00Z' }

function bodyView() {
  return {
    id: RECORD_ID,
    ref: RECORD_REF,
    title: 'The body room',
    doc_type_name: 'task',
    created: '2026-11-01T00:00:00Z',
    updated: temper.updated,
    is_active: true,
    origin_uri: '',
    owner_handle: 'fixture-owner',
    context_ref: '+temper-dev/contrib',
    cogmap_name: null,
    managed_meta: { 'temper-stage': 'in-progress' },
    content: temper.body,
    body_token: temper.token,
    body_storage: 'verbatim'
  }
}

const originalDeps = { ...deps }
const originalRoom = { ...roomDeps }
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  deps.run = originalDeps.run
  deps.fetch = originalDeps.fetch
  roomDeps.now = originalRoom.now
  Object.assign(temper, { body: BODY, token: 'bt1.first', updated: '2026-11-20T01:00:00Z' })
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function worktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-temper-live-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  git(repo, 'config', 'user.name', 'fixture')
  await writeFile(join(repo, 'README.md'), 'fixture\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'fixture')
  const linked = join(root, 'linked')
  git(repo, 'worktree', 'add', '-q', '-b', 'linked', linked)
  return linked
}

/** Signed in, temper answering from `temper`, every body read counted. */
function signedIn(reads: Request[]): void {
  deps.run = async (args) =>
    args[0] === 'auth' && args[1] === 'status'
      ? { code: 0, stdout: '{"api_url":"https://temper.example"}\n', stderr: '' }
      : { code: 0, stdout: `${TOKEN}\n`, stderr: '' }
  deps.fetch = async (input: Request) => {
    reads.push(input)
    return new Response(JSON.stringify(bodyView()), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
}

/** The worker opened on the record, the view file on disk, and the tab following it. */
async function openedTab() {
  const path = await worktree()
  const reads: Request[] = []
  signedIn(reads)
  roomDeps.now = () => OPENED_AT
  const host = mockHost({
    settings: { apiUrl: 'https://temper.example' },
    results: {
      'workspace.readContext': () => ({ workspaceId: WORKSPACE_ID, branch: 'linked', displayName: 'linked', terminals: [] }),
      'workspace.list': () => ({
        workspaces: [{ id: WORKSPACE_ID, kind: 'worktree', name: 'linked', path, branch: 'linked', hostId: 'local' }],
        truncated: false
      }),
      'editor.open': () => ({ opened: true })
    }
  })
  const worker: TestWorker = await mountWorker(main, { host })
  cleanups.push(() => worker.deactivate())
  const opened = await worker.request('temper.body.open', { id: RECORD_ID })
  assert.equal(opened.state, 'opened', JSON.stringify(opened))
  if (opened.state !== 'opened') throw new Error('not opened')
  const file = join(path, opened.path)

  const editor = mockEditorHost({ text: await readFile(file, 'utf8') })
  cleanups.push(() => editor.dispose())
  const states: RoomState[] = []
  const ticks: { ms: number; tick: () => void }[] = []
  const document = editor.orca.document
  if (!document) throw new Error('the mock editor host has no document')
  const room: Room = openRoom(
    {
      document,
      held: async (id) => (host.data().storage[heldBaseKey(id)] as HeldBase | undefined) ?? null,
      check: (id) => worker.request('temper.body.base', { id }),
      every: (ms, tick) => {
        ticks.push({ ms, tick })
        return () => undefined
      }
    },
    (state) => states.push(state)
  )
  cleanups.push(() => room.dispose())
  await settle()
  return { editor, room, states, ticks, reads, file }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function lastRecord(states: readonly RoomState[]) {
  const last = states[states.length - 1]
  assert.ok(last && last.kind === 'record', `the tab draws a record, not ${JSON.stringify(last)}`)
  return last
}

test('orca_view_says_when_its_base_is_behind', async () => {
  const { states, ticks, reads } = await openedTab()

  // On open: one check, answered current.
  let header = headerWords(lastRecord(states))
  assert.equal(header.base, 'Base read 2026-11-20 17:38 UTC')
  assert.equal(header.behind, false)
  assert.match(header.freshness, /^Current/)
  const readsAfterOpen = reads.length

  // Another writer changes the record in temper. Nothing is saved and nothing is reopened.
  Object.assign(temper, { body: `${BODY}Another writer's line.\n`, token: 'bt1.second', updated: '2026-11-20T17:50:00Z' })
  roomDeps.now = () => CHECKED_AT

  // The minute's check runs — the interval is no tighter than a minute.
  const interval = ticks[0]
  assert.ok(interval, 'the tab checks on an interval')
  assert.ok(interval.ms >= 60_000 && interval.ms === CHECK_INTERVAL_MS)
  interval.tick()
  await settle()

  header = headerWords(lastRecord(states))
  assert.equal(header.behind, true, 'the tab says it is behind')
  assert.equal(
    header.freshness,
    'Behind — temper has moved past this base, changed 2026-11-20 17:50 UTC (checked 2026-11-20 17:52 UTC). This view is not the current record.'
  )
  // The base it states is still the one it read, not the newer one.
  assert.equal(header.base, 'Base read 2026-11-20 17:38 UTC')
  assert.equal(reads.length, readsAfterOpen + 1, 'one read per check')
  assert.ok(reads.every((read) => read.method === 'GET'), 'a check writes nothing to temper')
})

test('orca_view_shows_every_change_from_its_base', async () => {
  const { editor, states, file } = await openedTab()
  const before = lastRecord(states)
  assert.equal(before.base.kind, 'held')
  assert.equal(headerWords(before).change, 'No changes from the base')

  // An agent writes the view file on disk; Orca replays it to the frame as an outside change.
  const original = await readFile(file, 'utf8')
  const edited = original
    .replace('One press.\n', 'One press, then a second.\n')
    .concat('\n## Added by an agent\n')
  await writeFile(file, edited, 'utf8')
  editor.replace(edited)
  await settle()

  const after = lastRecord(states)
  assert.equal(after.base.kind, 'held')
  if (after.base.kind !== 'held') return
  const { change } = after.base
  assert.deepEqual(
    change.lines.filter((line) => line.kind !== 'same'),
    [
      { kind: 'removed', text: 'One press.' },
      { kind: 'added', text: 'One press, then a second.' },
      { kind: 'added', text: '' },
      { kind: 'added', text: '## Added by an agent' }
    ]
  )
  assert.equal(headerWords(after).change, '3 lines added, 1 line removed since the base')
  // The tab posted nothing back: the change is shown, not made.
  assert.equal(editor.edits.length, 0)
})

test('until a check answers, and when it cannot, the tab never says it is current', async () => {
  const { states, ticks } = await openedTab()
  // The first state drawn, before any answer, is not "current".
  const first = states.find((state) => state.kind === 'record')
  assert.ok(first && first.kind === 'record')
  assert.equal(first.freshness.kind, 'checking')
  assert.equal(/^Current/.test(headerWords(first).freshness), false)

  // Signed out mid-view: the check cannot answer, and the header says so instead of "current".
  deps.run = async () => ({ code: 1, stdout: '{"error":{"code":"NOT_AUTHENTICATED"}}\n', stderr: '' })
  deps.fetch = async () => new Response('{}', { status: 401 })
  ticks[0]?.tick()
  await settle()
  const header = headerWords(lastRecord(states))
  assert.match(header.freshness, /^Not known whether temper has moved past this base/)
})

test('focusing the tab checks again, without waiting for the minute', async () => {
  const { states, room } = await openedTab()
  Object.assign(temper, { body: `${BODY}Moved on.\n`, token: 'bt1.second' })
  await room.recheck()
  assert.equal(headerWords(lastRecord(states)).behind, true)
})

test('a record with no held base answers no-base, and reads nothing from temper', async () => {
  const reads: Request[] = []
  signedIn(reads)
  const worker = await mountWorker(main, { host: mockHost({ settings: { apiUrl: 'https://temper.example' } }) })
  cleanups.push(() => worker.deactivate())
  const answer = await worker.request('temper.body.base', { id: RECORD_ID })
  assert.equal(answer.state, 'no-base')
  assert.equal(reads.length, 0)
})
