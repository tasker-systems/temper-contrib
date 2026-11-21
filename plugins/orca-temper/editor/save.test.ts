// Save, end to end in Node: the worker opens a record's body (a real git worktree, the host mock,
// deps standing in for the temper CLI and temper's API), the custom editor's room follows the view
// file through `mockEditorHost`, and the fake CLI keeps every argument list it was run with, so a
// write to temper can never go unseen. The fake honours `--expect-body` as temper does.
//
// Witnesses, first: `orca_only_a_save_reaches_temper` (only-a-save-reaches-temper) and
// `orca_stale_save_writes_nothing` (a-stale-save-never-overwrites); then no-save-without-a-base.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, assert, mockEditorHost, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import { deps } from '../src/deps'
import { roomDeps } from '../src/editor-room/deps'
import { heldBaseKey, type HeldBase } from '../src/editor-room/protocol'
import { SAVE_PERSONA } from '../src/editor-room/save'
import * as main from '../src/worker'
import { headerWords, openRoom, type Room, type RoomDeps, type RoomState } from './room'
import { parseViewFile } from './view-file'

// One window for every DOM test in this run: the sanitizer binds to the first window it sees.
const globals = globalThis as unknown as Record<string, unknown>
if (globals.document === undefined) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  for (const name of ['window', 'document', 'Element', 'Node', 'DocumentFragment', 'NodeFilter', 'HTMLElement']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name]
  }
}
const frameWindow = globals.window as Window & typeof globalThis
const { roomView } = await import('./view')

const RECORD_ID = '00000000-0000-7000-8000-0000000000f3'
const RECORD_REF = `the-save-room-${RECORD_ID}`
const BODY = '## Problem\n\nThe body, as temper stores it.\n\n## What to build\n\nOne press.\n'
const OPENED_AT = new Date('2026-11-20T17:38:00Z')
const SAVED_AT = new Date('2026-11-20T18:05:00Z')
const WORKSPACE_ID = 'fixture-repo::linked'

function fakeToken(expiresAtSeconds: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'none' })}.${encode({ exp: expiresAtSeconds })}.sig`
}
const TOKEN = fakeToken(4_102_444_800)

/** What temper holds now; a test changes it to stand in for another writer. */
const temper = { body: BODY, token: 'bt1.first', updated: '2026-11-20T01:00:00Z' }
const FIRST = { ...temper }

function bodyView() {
  return {
    id: RECORD_ID,
    ref: RECORD_REF,
    title: 'The save room',
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
  deps.runOrca = originalDeps.runOrca
  deps.fetch = originalDeps.fetch
  roomDeps.now = originalRoom.now
  Object.assign(temper, FIRST)
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function worktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-temper-save-test-'))
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

/** Every CLI run, and the body each `resource update` sent (read from its `@file`). */
interface Seen {
  cli: string[][]
  sentBodies: string[]
  reads: Request[]
  launches: { workspaceId: string; agent: string; prompt?: string }[]
}

/** The CLI runs that would write to temper. */
function temperWrites(seen: Seen): string[][] {
  return seen.cli.filter((args) => args[0] === 'resource')
}

/** Signed in; temper answering from `temper`; the CLI's guarded update as temper runs it. */
function signedIn(seen: Seen): void {
  deps.run = async (args) => {
    seen.cli.push([...args])
    if (args[0] === 'auth' && args[1] === 'status') {
      return { code: 0, stdout: '{"api_url":"https://temper.example"}\n', stderr: '' }
    }
    if (args[0] === 'resource' && args[1] === 'update') {
      const source = args[args.indexOf('--body') + 1] ?? ''
      const body = await readFile(source.slice(1), 'utf8')
      seen.sentBodies.push(body)
      const expected = args[args.indexOf('--expect-body') + 1]
      if (expected !== temper.token) {
        const refusal = {
          code: 'PRECONDITION_FAILED',
          message: '1 precondition failed: body',
          details: { failed: [{ tier: 'body', expected, current: temper.token }] }
        }
        return { code: 1, stdout: `${JSON.stringify(refusal)}\n`, stderr: '' }
      }
      Object.assign(temper, { body, token: 'bt1.saved', updated: '2026-11-20T18:05:00Z' })
      return {
        code: 0,
        stdout: `${JSON.stringify({ status: 'ok', id: RECORD_ID, body_token: temper.token, updated: temper.updated })}\n`,
        stderr: ''
      }
    }
    return { code: 0, stdout: `${TOKEN}\n`, stderr: '' }
  }
  deps.runOrca = async () => ({
    code: 0,
    stdout: JSON.stringify({ result: { agents: [{ id: 'claude', name: 'Claude', default: true }] } }),
    stderr: ''
  })
  deps.fetch = async (input: Request) => {
    seen.reads.push(input)
    return new Response(JSON.stringify(bodyView()), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
}

function roomDepsFor(worker: TestWorker, document: RoomDeps['document']): RoomDeps {
  return {
    document,
    held: async (id) => (worker.host.data().storage[heldBaseKey(id)] as HeldBase | undefined) ?? null,
    check: (id) => worker.request('temper.body.base', { id }),
    every: () => () => undefined,
    local: (id) => worker.request('temper.body.local', { id }),
    save: (id, text) => worker.request('temper.body.save', { id, text }),
    rebase: (id, discard) => worker.request('temper.body.rebase', { id, discard }),
    agents: () => worker.request('temper.launch.agents'),
    launch: (input) => worker.request('temper.launch.go', input)
  }
}

/** The worker opened on the record, the view file on disk, and the tab following it. */
async function openedTab() {
  const path = await worktree()
  const seen: Seen = { cli: [], sentBodies: [], reads: [], launches: [] }
  signedIn(seen)
  roomDeps.now = () => OPENED_AT
  const host = mockHost({
    settings: { apiUrl: 'https://temper.example' },
    results: {
      'workspace.readContext': () => ({ workspaceId: WORKSPACE_ID, branch: 'linked', displayName: 'linked', terminals: [] }),
      'workspace.list': () => ({
        workspaces: [{ id: WORKSPACE_ID, kind: 'worktree', name: 'linked', path, branch: 'linked', hostId: 'local' }],
        truncated: false
      }),
      'editor.open': () => ({ opened: true }),
      'agent.launch': (params: { workspaceId: string; agent: string; prompt?: string }) => {
        seen.launches.push(params)
        return { terminalId: 'terminal-1' }
      }
    }
  })
  const worker: TestWorker = await mountWorker(main, { host })
  cleanups.push(() => worker.deactivate())
  const opened = await worker.request('temper.body.open', { id: RECORD_ID })
  assert.equal(opened.state, 'opened', JSON.stringify(opened))
  if (opened.state !== 'opened') throw new Error('not opened')
  const file = join(path, opened.path)
  const tab = await follow(worker, await readFile(file, 'utf8'))
  return { ...tab, worker, seen, file }
}

/** A tab on the view: the room following a mock editor host's document. */
async function follow(worker: TestWorker, text: string) {
  const editor = mockEditorHost({ text })
  cleanups.push(() => editor.dispose())
  const states: RoomState[] = []
  const document = editor.orca.document
  if (!document) throw new Error('the mock editor host has no document')
  const room: Room = openRoom(roomDepsFor(worker, document), (state) => states.push(state))
  cleanups.push(() => room.dispose())
  await settle()
  return { editor, room, states }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function lastRecord(states: readonly RoomState[]) {
  const last = states[states.length - 1]
  assert.ok(last && last.kind === 'record', `the tab draws a record, not ${JSON.stringify(last)}`)
  return last
}

function edit(text: string): string {
  return text.replace('One press.\n', 'One press, then a second.\n').concat('\n## Added in the tab\n')
}

function editedBody(text: string): string {
  const view = parseViewFile(edit(text))
  if (view === null) throw new Error('the edited view does not parse')
  return view.body
}

/** Draws a state as the frame would, and answers the drawn root. */
function drawn(state: RoomState): HTMLElement {
  const root = frameWindow.document.createElement('main')
  frameWindow.document.body.replaceChildren(root)
  const noop = () => undefined
  roomView(root, { openExternal: noop, save: noop, carryOver: noop, discard: noop, handOff: noop })(state)
  return root
}

function buttons(root: HTMLElement): Map<string, HTMLButtonElement> {
  return new Map(Array.from(root.querySelectorAll('button')).map((node) => [node.textContent ?? '', node as HTMLButtonElement]))
}

test('orca_only_a_save_reaches_temper', async () => {
  const { editor, room, states, worker, seen, file } = await openedTab()
  const original = await readFile(file, 'utf8')
  const edited = edit(original)

  // Editing in Orca's editor reaches the tab as a new document: nothing goes to temper.
  editor.replace(edited)
  await settle()
  assert.equal(headerWords(lastRecord(states)).change, '3 lines added, 1 line removed since the base')
  assert.equal(headerWords(lastRecord(states)).local, null, 'nothing is saved locally yet')

  // A local file save (Cmd+S writes the file): temper is untouched, and the tab says so.
  await writeFile(file, edited, 'utf8')
  await room.recheck()
  const local = headerWords(lastRecord(states)).local
  assert.ok(local !== null, 'the tab says a local save happened')
  assert.match(local, /^Saved locally .* — that save did not reach temper\. Only Save sends this text to temper\.$/)
  assert.equal(drawn(lastRecord(states)).querySelector('.room-local')?.textContent, local, 'the view draws the notice')

  // Closing the tab and opening it again: a reopen from the rail refuses over the changed view,
  // and a fresh tab on the same file says the same. Still nothing went to temper.
  room.dispose()
  const reopened = await worker.request('temper.body.open', { id: RECORD_ID })
  assert.equal(reopened.state, 'refused')
  const again = await follow(worker, await readFile(file, 'utf8'))
  assert.match(headerWords(lastRecord(again.states)).local ?? '', /did not reach temper/)
  assert.deepEqual(temperWrites(seen), [], 'editing, a local save, closing and reopening wrote nothing to temper')
  assert.ok(seen.reads.every((read) => read.method === 'GET'), 'and every API call was a read')
  assert.equal(temper.token, 'bt1.first')
  assert.equal(temper.body, BODY)

  // Save: exactly one guarded update, with the held token, as the person through the plugin's UI.
  roomDeps.now = () => SAVED_AT
  await again.room.save()
  await settle()
  const writes = temperWrites(seen)
  assert.equal(writes.length, 1, 'Save issued exactly one write')
  const [args] = writes
  assert.ok(args)
  const bodyArg = args[4] ?? ''
  assert.deepEqual(args, [
    'resource',
    'update',
    RECORD_ID,
    '--body',
    bodyArg,
    '--expect-body',
    'bt1.first',
    '--persona',
    SAVE_PERSONA,
    '--confidence',
    'confident',
    '--format',
    'json'
  ])
  assert.match(bodyArg, /^@/)
  assert.equal(args.includes('--model'), false, 'a pressed Save names no model')
  // Only the body is sent: the frontmatter is the view's own.
  assert.equal(seen.sentBodies[0], editedBody(original))
  assert.equal(temper.body, editedBody(original))

  // Accepted: the held base is the saved version, and the difference is empty.
  const after = lastRecord(again.states)
  assert.equal(after.save.kind, 'saved')
  assert.equal(after.base.kind, 'held')
  if (after.base.kind !== 'held') return
  assert.equal(after.base.held.body_token, 'bt1.saved')
  assert.equal(after.base.held.base, editedBody(original))
  assert.equal(after.base.held.read_at, SAVED_AT.toISOString())
  assert.equal(headerWords(after).change, 'No changes from the base')
  assert.equal(headerWords(after).local, null, 'the file on disk is now what temper holds')
  assert.match(headerWords(after).freshness, /^Current/)
})

test('orca_stale_save_writes_nothing', async () => {
  const { editor, room, states, seen, file } = await openedTab()
  const original = await readFile(file, 'utf8')
  const edited = edit(original)
  await writeFile(file, edited, 'utf8')
  editor.replace(edited)
  await settle()

  // Another writer changes the record in temper after the open.
  const theirs = `${BODY}\n## Another writer's section\n`
  Object.assign(temper, { body: theirs, token: 'bt1.other', updated: '2026-11-20T17:50:00Z' })
  const readsBefore = seen.reads.length

  await room.save()
  await settle()

  // The guarded write was sent with the held token, and refused: temper keeps the other version.
  const writes = temperWrites(seen)
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.[writes[0].indexOf('--expect-body') + 1], 'bt1.first')
  assert.equal(temper.body, theirs, "the other writer's version stays in temper")
  assert.equal(temper.token, 'bt1.other')
  assert.equal(seen.reads.length, readsBefore + 1, "one read of temper's current")

  // Three versions: the base, the person's, temper's current.
  const state = lastRecord(states)
  assert.equal(state.save.kind, 'stale')
  if (state.save.kind !== 'stale') return
  assert.equal(state.save.versions.base, BODY)
  assert.equal(state.save.versions.mine, editedBody(original))
  assert.equal(state.save.versions.current, theirs)
  assert.equal(headerWords(state).behind, true)

  // Drawn: the three versions, and carry-over, discard and hand-to-agent offered.
  const root = drawn(state)
  const versions = Array.from(root.querySelectorAll('.room-version pre')).map((node) => node.textContent)
  assert.deepEqual(versions.slice(0, 3), [BODY, editedBody(original), theirs])
  const offered = buttons(root)
  for (const label of [
    'Carry my change onto the current version',
    'Discard mine — take the current version',
    'Hand to an agent'
  ]) {
    assert.ok(offered.has(label), `offers "${label}"`)
    assert.equal(offered.get(label)?.disabled, false, `"${label}" can be pressed`)
  }
  assert.equal(offered.get('Save to temper')?.disabled, true, 'Save waits for the person to choose')
})

test('carrying over makes the current version the base and keeps the person’s text; the next Save is guarded on it', async () => {
  const { editor, room, states, seen, file } = await openedTab()
  const original = await readFile(file, 'utf8')
  const edited = edit(original)
  await writeFile(file, edited, 'utf8')
  editor.replace(edited)
  await settle()
  const theirs = `${BODY}\n## Another writer's section\n`
  Object.assign(temper, { body: theirs, token: 'bt1.other' })
  await room.save()
  await settle()

  await room.carryOver()
  await settle()
  const state = lastRecord(states)
  assert.equal(state.base.kind, 'held')
  if (state.base.kind !== 'held') return
  assert.equal(state.base.held.body_token, 'bt1.other')
  assert.equal(state.base.held.base, theirs)
  assert.equal(state.view.body, editedBody(original), "the person's text stays as the working text")
  assert.equal(await readFile(file, 'utf8'), edited, 'the view file is not touched')
  assert.equal(temperWrites(seen).length, 1, 'carrying over writes nothing to temper')

  await room.save()
  await settle()
  const writes = temperWrites(seen)
  assert.equal(writes.length, 2)
  assert.equal(writes[1]?.[writes[1].indexOf('--expect-body') + 1], 'bt1.other')
  assert.equal(lastRecord(states).save.kind, 'saved')
})

test('discarding drops the person’s text for the current version, and writes nothing to temper', async () => {
  const { editor, room, states, seen, file } = await openedTab()
  const edited = edit(await readFile(file, 'utf8'))
  await writeFile(file, edited, 'utf8')
  editor.replace(edited)
  await settle()
  const theirs = `${BODY}\n## Another writer's section\n`
  Object.assign(temper, { body: theirs, token: 'bt1.other' })
  await room.save()
  await settle()

  await room.discard()
  await settle()
  const onDisk = parseViewFile(await readFile(file, 'utf8'))
  assert.equal(onDisk?.body, theirs, "the view file holds temper's current")
  editor.replace(await readFile(file, 'utf8'))
  await settle()
  const state = lastRecord(states)
  assert.equal(headerWords(state).change, 'No changes from the base')
  assert.equal(state.base.kind === 'held' && state.base.held.body_token, 'bt1.other')
  assert.equal(temperWrites(seen).length, 1, 'only the refused save was ever sent')
  assert.equal(temper.body, theirs)
})

test('handing a refused save to an agent sends the desktop’s handoff prompt through agent.launch, here', async () => {
  const { editor, room, states, seen, file } = await openedTab()
  const original = await readFile(file, 'utf8')
  const edited = edit(original)
  await writeFile(file, edited, 'utf8')
  editor.replace(edited)
  await settle()
  const theirs = `${BODY}\n## Another writer's section\n`
  Object.assign(temper, { body: theirs, token: 'bt1.other' })
  await room.save()
  await settle()

  await room.handOff('claude', 'keep both sections')
  await settle()
  assert.equal(seen.launches.length, 1)
  const [launch] = seen.launches
  assert.equal(launch?.workspaceId, WORKSPACE_ID)
  assert.equal(launch?.agent, 'claude')
  const prompt = launch?.prompt ?? ''
  assert.match(prompt, /^I was editing "The save room" in temper, but the document changed since I opened it/)
  assert.match(prompt, /Intent: keep both sections/)
  assert.ok(prompt.includes(`### What I had written (my draft)\n\n\`\`\`markdown\n${editedBody(original)}\n\`\`\``))
  assert.ok(prompt.includes(`### What the document reads now (the newer version)\n\n\`\`\`markdown\n${theirs}\n\`\`\``))
  assert.ok(prompt.includes(`### What the document read when I opened it (the base)\n\n\`\`\`markdown\n${BODY}\n\`\`\``))
  assert.ok(prompt.includes(file), 'the prompt names the view file the agent works in')
  // The agent reconciles onto the current version: the base moved there first.
  const state = lastRecord(states)
  assert.equal(state.base.kind === 'held' && state.base.held.body_token, 'bt1.other')
  assert.equal(state.save.kind, 'idle')
  assert.equal(temperWrites(seen).length, 1, 'handing off writes nothing to temper')
})

test('no save runs without a held body token: refused before the CLI runs', async () => {
  const seen: Seen = { cli: [], sentBodies: [], reads: [], launches: [] }
  signedIn(seen)
  const worker = await mountWorker(main, { host: mockHost({ settings: { apiUrl: 'https://temper.example' } }) })
  cleanups.push(() => worker.deactivate())
  const text = `---\nid: "${RECORD_ID}"\nref: "${RECORD_REF}"\ntitle: "The save room"\ndoc_type: "task"\nbase_read_at: "2026-11-20T17:38:00.000Z"\n---\n${BODY}changed\n`

  // The worker: no held base, no CLI.
  const answer = await worker.request('temper.body.save', { id: RECORD_ID, text })
  assert.equal(answer.state, 'no-base')
  // A held base without a token is no base either.
  await (async () => {
    const held = { id: RECORD_ID, body_token: '', base: BODY, read_at: '2026-11-20T17:38:00Z', path: '/nowhere', workspaceId: 'w' }
    const storageWorker = await mountWorker(main, {
      host: mockHost({ settings: { apiUrl: 'https://temper.example' }, storage: { [heldBaseKey(RECORD_ID)]: held } })
    })
    cleanups.push(() => storageWorker.deactivate())
    const tokenless = await storageWorker.request('temper.body.save', { id: RECORD_ID, text })
    assert.equal(tokenless.state, 'no-base')
  })()
  assert.deepEqual(seen.cli, [], 'the CLI never ran — not even to mint a token')
  assert.deepEqual(seen.reads, [])

  // The room: with no base held, Save refuses in the tab and never asks the worker.
  const editor = mockEditorHost({ text })
  cleanups.push(() => editor.dispose())
  const document = editor.orca.document
  if (!document) throw new Error('no document')
  const asked: string[] = []
  const states: RoomState[] = []
  const room = openRoom(
    {
      ...roomDepsFor(worker, document),
      save: async (id, body) => {
        asked.push(id)
        return worker.request('temper.body.save', { id, text: body })
      }
    },
    (state) => states.push(state)
  )
  cleanups.push(() => room.dispose())
  await settle()
  await room.save()
  const state = lastRecord(states)
  assert.equal(state.save.kind, 'refused')
  assert.match(state.save.kind === 'refused' ? state.save.message : '', /no base is held/)
  assert.deepEqual(asked, [], 'the room never sent a save')
  assert.equal(buttons(drawn(state)).get('Save to temper')?.disabled, true)
})
