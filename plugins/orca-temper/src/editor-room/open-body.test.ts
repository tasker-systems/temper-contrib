// The editor room's worker tests: the witness `orca_body_opens_in_an_editor_tab` first, then its
// companions. Each test stands up a real git repository in a temporary folder (a linked
// worktree where the common git dir matters), the orca host mock answering the focused
// workspace, and deps.ts standing in for the temper CLI and the network.
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test, afterEach } from 'orca/testing'
import { deps } from '../deps'
import * as main from '../worker'
import { parseViewFile } from '../../editor/view-file'
import { roomDeps } from './deps'
import { heldBaseKey, type HeldBase } from './protocol'

const RECORD_ID = '00000000-0000-7000-8000-0000000000f1'
const RECORD_REF = `the-body-room-${RECORD_ID}`
const BODY = '## Problem\n\nThe body, as temper stores it.\n\n## What to build\n\nOne press.\n'
const BODY_TOKEN = 'bt1.fixture-token'
const READ_AT = new Date('2026-11-20T17:38:00Z')

function fakeToken(expiresAtSeconds: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'none' })}.${encode({ exp: expiresAtSeconds })}.sig`
}
const TOKEN = fakeToken(4_102_444_800)

/** A single-record read that asked for the body: its content, token and storage. */
function bodyView(extra: Record<string, unknown> = {}) {
  return {
    id: RECORD_ID,
    ref: RECORD_REF,
    title: 'The body room',
    doc_type_name: 'task',
    created: '2026-11-01T00:00:00Z',
    updated: '2026-11-20T01:00:00Z',
    is_active: true,
    origin_uri: '',
    owner_handle: 'fixture-owner',
    context_ref: '+temper-dev/contrib',
    cogmap_name: null,
    managed_meta: { 'temper-stage': 'in-progress', 'temper-mode': 'build' },
    content: BODY,
    body_token: BODY_TOKEN,
    body_storage: 'verbatim',
    ...extra
  }
}

const originalDeps = { ...deps }
const originalRoom = { ...roomDeps }
const cleanups: string[] = []
afterEach(async () => {
  deps.run = originalDeps.run
  deps.fetch = originalDeps.fetch
  roomDeps.now = originalRoom.now
  roomDeps.git = originalRoom.git
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A repository with one commit and a linked worktree; the worktree is the focused workspace. */
async function repoWithWorktree(): Promise<{ main: string; worktree: string; commonDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-temper-room-'))
  cleanups.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  git(repo, 'config', 'user.name', 'fixture')
  await writeFile(join(repo, 'README.md'), 'fixture\n')
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'fixture')
  const worktree = join(root, 'linked')
  git(repo, 'worktree', 'add', '-q', '-b', 'linked', worktree)
  return { main: repo, worktree, commonDir: join(repo, '.git') }
}

const WORKSPACE_ID = 'fixture-repo::linked'

/** The orca host as a desktop with `path` focused, answering editor.open. */
function hostFocusedOn(path: string, options: { focused?: boolean; kind?: 'worktree' | 'folder' } = {}) {
  return mockHost({
    settings: { apiUrl: 'https://temper.example' },
    results: {
      'workspace.readContext': () =>
        options.focused === false
          ? null
          : { workspaceId: WORKSPACE_ID, branch: 'linked', displayName: 'linked', terminals: [] },
      'workspace.list': () => ({
        workspaces: [
          {
            id: WORKSPACE_ID,
            kind: options.kind ?? 'worktree',
            name: 'linked',
            path,
            branch: 'linked',
            hostId: 'local'
          }
        ],
        truncated: false
      }),
      'editor.open': () => ({ opened: true })
    }
  })
}

function signedIn(requests: Request[] = []): void {
  deps.run = async (args) =>
    args[0] === 'auth' && args[1] === 'status'
      ? { code: 0, stdout: '{"api_url":"https://temper.example"}\n', stderr: '' }
      : { code: 0, stdout: `${TOKEN}\n`, stderr: '' }
  deps.fetch = async (input: Request) => {
    requests.push(input)
    return new Response(JSON.stringify(bodyView()), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  roomDeps.now = () => READ_AT
}

/** Every host call that would move the person's view. */
const VIEW_MOVING = ['workspace.open', 'terminal.focus', 'commands.run']

test('orca_body_opens_in_an_editor_tab', async () => {
  const { worktree, commonDir } = await repoWithWorktree()
  const requests: Request[] = []
  signedIn(requests)
  const host = hostFocusedOn(worktree)
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.body.open', { id: RECORD_ID })

  assert.equal(answer.state, 'opened', JSON.stringify(answer))
  if (answer.state !== 'opened') return
  const relative = `.temper-views/${RECORD_REF}.temper.md`
  const absolute = join(worktree, relative)
  assert.equal(answer.path, relative)
  assert.equal(answer.readAt, READ_AT.toISOString())

  // The view file holds the record's body under its meta.
  const parsed = parseViewFile(await readFile(absolute, 'utf8'))
  assert.ok(parsed, 'the view file opens with the frontmatter the editor reads')
  assert.equal(parsed.body, BODY)
  assert.equal(parsed.header.id, RECORD_ID)
  assert.equal(parsed.header.title, 'The body room')
  assert.equal(parsed.header.readAt, READ_AT.toISOString())
  assert.equal(parsed.header.meta['temper-stage'], 'in-progress')

  // The read asked for the body by the bare UUID.
  const url = new URL(requests[0]?.url ?? 'http://none')
  assert.equal(url.pathname, `/api/resources/${RECORD_ID}`)
  assert.equal(url.searchParams.get('sections'), 'body')

  // The held base is in plugin storage.
  const held = host.data().storage[heldBaseKey(RECORD_ID)] as HeldBase | undefined
  assert.deepEqual(held, {
    id: RECORD_ID,
    body_token: BODY_TOKEN,
    base: BODY,
    read_at: READ_AT.toISOString(),
    path: absolute,
    workspaceId: WORKSPACE_ID
  })

  // editor.open for that file in the focused workspace, and nothing that moves the view.
  assert.deepEqual(host.callsOf('editor.open'), [{ workspaceId: WORKSPACE_ID, path: relative }])
  for (const method of VIEW_MOVING) {
    assert.equal(host.callsOf(method).length, 0, `${method} would move the person's view`)
  }
  // And the repository stays clean: the view is excluded in the common git dir.
  assert.equal(git(worktree, 'status', '--porcelain'), '')
  assert.match(await readFile(join(commonDir, 'info', 'exclude'), 'utf8'), /^\.temper-views\/$/m)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('the exclude entry is added once, in the common git dir, never to a tracked file', async () => {
  const { main: repo, worktree, commonDir } = await repoWithWorktree()
  signedIn()
  const host = hostFocusedOn(worktree)
  const worker = await mountWorker(main, { host })

  assert.equal((await worker.request('temper.body.open', { id: RECORD_ID })).state, 'opened')
  assert.equal((await worker.request('temper.body.open', { id: RECORD_ID })).state, 'opened')

  const exclude = await readFile(join(commonDir, 'info', 'exclude'), 'utf8')
  assert.equal(exclude.split('\n').filter((line) => line === '.temper-views/').length, 1)
  // The tracked ignore file is untouched, in the worktree and the main checkout alike.
  assert.equal(await readFile(join(worktree, '.gitignore'), 'utf8'), 'node_modules/\n')
  assert.equal(await readFile(join(repo, '.gitignore'), 'utf8'), 'node_modules/\n')
  // One entry in the common dir covers the main checkout too.
  await mkdir(join(repo, '.temper-views'))
  await writeFile(join(repo, '.temper-views', 'x.temper.md'), 'x')
  assert.equal(git(repo, 'status', '--porcelain'), '')
  await worker.deactivate()
})

test('an exclude line already covering the folder is left as it is', async () => {
  const { worktree, commonDir } = await repoWithWorktree()
  await mkdir(join(commonDir, 'info'), { recursive: true })
  await writeFile(join(commonDir, 'info', 'exclude'), '# mine\n/.temper-views\n')
  signedIn()
  const worker = await mountWorker(main, { host: hostFocusedOn(worktree) })
  assert.equal((await worker.request('temper.body.open', { id: RECORD_ID })).state, 'opened')
  assert.equal(await readFile(join(commonDir, 'info', 'exclude'), 'utf8'), '# mine\n/.temper-views\n')
  await worker.deactivate()
})

test('with no focused workspace the press refuses, naming why, and writes nothing', async () => {
  const { worktree } = await repoWithWorktree()
  const requests: Request[] = []
  signedIn(requests)
  const host = hostFocusedOn(worktree, { focused: false })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.body.open', { id: RECORD_ID })
  assert.equal(answer.state, 'refused')
  if (answer.state !== 'refused') return
  assert.match(answer.message, /No workspace is focused/)
  assert.equal(requests.length, 0, 'nothing was read')
  assert.equal(host.callsOf('editor.open').length, 0)
  assert.equal(host.data().storage[heldBaseKey(RECORD_ID)], undefined)
  await worker.deactivate()
})

test('a folder workspace without git refuses, naming why', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-temper-folder-'))
  cleanups.push(folder)
  signedIn()
  // A git that finds no repository, whatever the machine's temp dir sits in.
  roomDeps.git = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' })
  const host = hostFocusedOn(folder, { kind: 'folder' })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.body.open', { id: RECORD_ID })
  assert.equal(answer.state, 'refused')
  if (answer.state !== 'refused') return
  assert.match(answer.message, /folder without git/)
  assert.equal(host.callsOf('editor.open').length, 0)
  await worker.deactivate()
})

test('a tracked file under .temper-views refuses rather than writing beside it', async () => {
  const { worktree } = await repoWithWorktree()
  await mkdir(join(worktree, '.temper-views'))
  await writeFile(join(worktree, '.temper-views', 'tracked.md'), 'tracked\n')
  git(worktree, 'add', '.temper-views/tracked.md')
  git(worktree, 'commit', '-q', '-m', 'tracked view')
  signedIn()
  const host = hostFocusedOn(worktree)
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.body.open', { id: RECORD_ID })
  assert.equal(answer.state, 'refused')
  assert.equal(host.callsOf('editor.open').length, 0)
  await worker.deactivate()
})

test('a body not stored verbatim is declined with the way out to temper, nothing written', async () => {
  const { worktree } = await repoWithWorktree()
  signedIn()
  deps.fetch = async () =>
    new Response(JSON.stringify(bodyView({ body_storage: 'derived' })), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  const host = hostFocusedOn(worktree)
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.body.open', { id: RECORD_ID })
  assert.equal(answer.state, 'refused')
  if (answer.state !== 'refused') return
  assert.match(answer.message, /not stored verbatim/)
  assert.match(answer.message, /Open in temper/)
  assert.equal(host.callsOf('editor.open').length, 0)
  assert.equal(host.data().storage[heldBaseKey(RECORD_ID)], undefined)
  assert.equal(git(worktree, 'status', '--porcelain'), '')
  await worker.deactivate()
})

test('a view an agent changed on disk is never overwritten by a second open', async () => {
  const { worktree } = await repoWithWorktree()
  signedIn()
  const host = hostFocusedOn(worktree)
  const worker = await mountWorker(main, { host })
  assert.equal((await worker.request('temper.body.open', { id: RECORD_ID })).state, 'opened')

  const path = join(worktree, '.temper-views', `${RECORD_REF}.temper.md`)
  const edited = (await readFile(path, 'utf8')).replace('One press.', 'An agent was here.')
  await writeFile(path, edited)

  const answer = await worker.request('temper.body.open', { id: RECORD_ID })
  assert.equal(answer.state, 'refused')
  assert.equal(await readFile(path, 'utf8'), edited)
  assert.equal(host.callsOf('editor.open').length, 1, 'only the first open opened a tab')
  await worker.deactivate()
})

test('signed out, Open body refuses as not connected and writes nothing', async () => {
  const { worktree } = await repoWithWorktree()
  deps.run = async () => ({ code: 1, stdout: '{"code":"UNAUTHENTICATED"}', stderr: '' })
  const host = hostFocusedOn(worktree)
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.body.open', { id: RECORD_ID })
  assert.equal(answer.state, 'not-connected')
  assert.equal(host.callsOf('editor.open').length, 0)
  assert.equal(git(worktree, 'status', '--porcelain'), '')
  await worker.deactivate()
})
