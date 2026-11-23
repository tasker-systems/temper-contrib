// The detail press's own path to the launch hook: a Start press on a task's detail, driven as
// the person makes it — the panel mounted on the same mock host as the worker, so every
// `plugin.request` the press issues — the detail read that composes the item, the launch picks,
// the launch itself — is answered by the worker's real handlers (an unstubbed name routes to the
// mounted worker), and the launch input is the panel's composition, never a hand-built one.
//
// Pinning here, against the live finding that the press's own agent got `TEMPER_TASK` but no
// `TEMPER_CONTEXT`:
//
//   a pressed Start whose item carries its context — the pending launch, the answer while
//   `workspace.create` is still out, holds both the task ref and the context ref; the stored
//   link and the serves marker carry it too; and no record is read for it, the press's item
//   already naming what the hook says;
//
//   a carried sheet whose composed item names no context — the launch still lands, and still
//   names the task's context: the worker reads the record's `context_ref` before
//   `workspace.create` (a temper read on the person's grant, inside the press), so the hook
//   answered from the pending launch gives both variables the press could not. A read that
//   fails or refuses blocks nothing: the launch runs with the context the item arrived with,
//   the link and marker carry none, and the strip's record read still teaches the link later.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assert,
  mockHost,
  mount,
  mountWorker,
  test,
  afterEach,
  type HookDecision,
  type MockHost,
  type TestPanel,
  type TestWorker
} from 'orca/testing'
import * as panel from './panel'
import * as main from './worker'
import { deps } from './deps'

const originalDeps = { ...deps }
const folders: string[] = []
afterEach(() => {
  deps.run = originalDeps.run
  deps.runOrca = originalDeps.runOrca
  deps.fetch = originalDeps.fetch
  for (const dir of folders.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A JWT the expiry reader accepts: the mint's stdout, one line. */
const encode = (value: object) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const TOKEN = `${encode({ alg: 'none' })}.${encode({ exp: 4_102_444_800 })}.sig`

const TASK_ID = '00000000-0000-7000-8000-0000000000b1'
const TASK_REF = `the-press-task-${TASK_ID}`
const TASK_TITLE = 'The pressed task'
const CONTEXT = '+team/workflows'
const PROJECT = 'repo-0003'
const LIST_ID = 'identity:wt2:local:press'
const MARKER = join('.temper-views', 'serves.json')

/** The record as the API answers it; the context the launch must name lives here. */
function recordView(contextRef: string | null) {
  return {
    id: TASK_ID,
    ref: TASK_REF,
    title: TASK_TITLE,
    doc_type_name: 'task',
    created: '2026-11-01T00:00:00Z',
    updated: '2026-11-20T01:00:00Z',
    is_active: true,
    origin_uri: '',
    originator_profile_id: '019d0000-0000-7000-8000-000000000000',
    owner_profile_id: '019d0000-0000-7000-8000-000000000000',
    owner_handle: 'fixture-owner',
    context_name: contextRef === null ? null : 'workflows',
    context_owner_ref: contextRef === null ? null : '+team',
    context_slug: contextRef === null ? null : 'workflows',
    context_ref: contextRef,
    cogmap_name: null,
    managed_meta: { 'temper-stage': 'backlog' }
  }
}

/** The outside world: the mint names a token, the origin comes from the setting, the reads answer.
 *  `refuse()` turns the reads off — for the read the launch itself would make. */
function fakeTemper(
  detail: unknown,
  reads: { recordCount: { count: number } }
): { refuse: () => void } {
  let refuse = false
  deps.run = async (args: readonly string[]) => {
    if (args.includes('export-token')) {
      return { code: 0, stdout: `${TOKEN}\n`, stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  deps.runOrca = async () => ({
    code: 0,
    stdout: JSON.stringify({
      id: 'x',
      ok: true,
      result: { agents: [{ id: 'claude', name: 'Claude', default: true }] }
    }),
    stderr: ''
  })
  deps.fetch = async (input: Request) => {
    const url = new URL(input.url)
    if (refuse) {
      throw new Error('the read refused')
    }
    if (url.pathname.startsWith('/api/resources/')) {
      reads.recordCount.count += 1
      return new Response(JSON.stringify(detail), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (url.pathname === '/api/resources') {
      return new Response(JSON.stringify({ rows: [], total: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response('{}', { status: 404 })
  }
  return { refuse: () => (refuse = true) }
}

function gitFolder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-temper-press-')))
  folders.push(dir)
  execFileSync('git', ['init', '--quiet', dir])
  return dir
}

function hookEvent(workspaceId: string) {
  return {
    agent: 'claude',
    workspaceId,
    workspaceKind: 'worktree' as const,
    command: 'claude',
    env: { KEEP: 'me' } as Record<string, string>
  }
}

/** The mock host of a launch: the create starts the press's agent before it answers. */
function launchHost(
  folder: string,
  started: { press: Promise<HookDecision<'agent.launch.before'>> | null },
  workerBox: { worker: TestWorker | null }
): MockHost {
  return mockHost({
    settings: { apiUrl: 'https://temper.example' },
    results: {
      'workspace.readContext': {
        workspaceId: 'ws-current',
        branch: 'pt/thing',
        displayName: 'checkout · pt/thing',
        terminals: []
      },
      'workspace.create': () => {
        started.press = workerBox.worker!.hooks.fire('agent.launch.before', hookEvent(`${PROJECT}::${folder}`))
        return { workspaceId: LIST_ID, terminalId: 't-press' }
      },
      'workspace.list': {
        workspaces: [
          {
            id: LIST_ID,
            kind: 'worktree',
            name: 'the-press',
            projectId: PROJECT,
            path: folder,
            branch: 'pt/the-press',
            hostId: 'local'
          }
        ],
        truncated: false
      },
      'project.list': {
        projects: [{ id: PROJECT, name: 'contrib', kind: 'git', hostId: 'local', path: '/work/contrib', hidden: false }],
        truncated: false
      }
    }
  })
}

/** Worker and panel on one host; the panel's requests route to the worker's real handlers. */
async function mountPanel(
  host: MockHost,
  persisted: Record<string, unknown>
): Promise<{ mounted: TestPanel; worker: TestWorker }> {
  const worker = await mountWorker(main, { host })
  const mounted = await mount(panel, { host, persisted: { plugin: persisted } })
  await mounted.settled()
  return { mounted, worker }
}

/** Carries the task detail: the view pushed as the person left it, its Start press lit. */
const SEEDED_STACK = { 'detail-stack': [{ id: TASK_ID, ref: '', title: '', docType: 'task' }] }

test('a detail press gives its own agent TEMPER_TASK and TEMPER_CONTEXT from the pending launch', async () => {
  const PATH = gitFolder()
  const reads = { recordCount: { count: 0 } }
  fakeTemper(recordView(CONTEXT), reads)
  const started: { press: Promise<HookDecision<'agent.launch.before'>> | null } = { press: null }
  const box: { worker: TestWorker | null } = { worker: null }
  const host = launchHost(PATH, started, box)
  const { mounted, worker } = await mountPanel(host, SEEDED_STACK)
  box.worker = worker

  const start = mounted.find({ type: 'Button', text: 'Start agent' })
  assert.notEqual(start, null, 'Start agent stands on the backlog task detail, the consents granted')
  await mounted.press(start!)
  await mounted.settled()

  const card = mounted.find({ type: 'Card', label: 'Start agent' })
  assert.ok(card, 'the sheet is open on the detail')
  const readsBeforeConfirm = reads.recordCount.count
  await mounted.select({ label: 'Project' }, PROJECT)
  const confirm = mounted
    .findAll({ type: 'Button', text: 'Start agent' })
    .find((button) => button.path.startsWith(card!.path))
  assert.ok(confirm, 'the sheet confirm stands')
  await mounted.press(confirm!)
  await mounted.settled()
  assert.ok(mounted.find({ type: 'Callout', label: 'The agent was launched.' }), 'the launch landed')

  assert.ok(started.press !== null, "Orca started the press's agent from inside workspace.create")
  const decided = await started.press
  assert.equal(decided.kind, 'continue')
  if (decided.kind !== 'continue') return
  assert.deepEqual(
    decided.event.env,
    { KEEP: 'me', TEMPER_TASK: TASK_REF, TEMPER_CONTEXT: CONTEXT },
    "the press's own agent is told the task and its context, from the pending launch"
  )
  assert.equal(
    reads.recordCount.count,
    readsBeforeConfirm,
    'the item already carried its context: the launch spends no record read on it'
  )

  const stored = (host.data().storage['launch-links'] as Record<string, unknown>[]).find(
    (link) => link.itemId === TASK_ID
  )
  assert.ok(stored, 'the launch stored its link')
  assert.equal(stored?.contextRef, CONTEXT, 'the stored link carries the context the press composed')
  const markerFile = join(PATH, MARKER)
  assert.ok(existsSync(markerFile), 'the workspace holds its serves marker')
  const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown>
  assert.equal(marker.context_ref, CONTEXT, 'the marker names the context too')

  const later = await worker.hooks.fire('agent.launch.before', hookEvent(`${PROJECT}::${PATH}`))
  assert.equal(later.kind, 'continue')
  if (later.kind !== 'continue') return
  assert.deepEqual(later.event.env, { KEEP: 'me', TEMPER_TASK: TASK_REF, TEMPER_CONTEXT: CONTEXT })
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  await worker.deactivate()
})

/** The sheet carried from the last run: confirmed, its composed item naming the task, no context. */
const CARRIED_SHEET = {
  ...SEEDED_STACK,
  'launch-compose': {
    kind: 'task-start',
    from: 'detail',
    item: { id: TASK_ID, ref: TASK_REF, title: TASK_TITLE, contextRef: null, docType: 'task' },
    handoffNext: null
  }
}

test('an item arriving without its context still launches, and the launch still names the task context', async () => {
  const PATH = gitFolder()
  const reads = { recordCount: { count: 0 } }
  fakeTemper(recordView(CONTEXT), reads)
  const started: { press: Promise<HookDecision<'agent.launch.before'>> | null } = { press: null }
  const box: { worker: TestWorker | null } = { worker: null }
  const host = launchHost(PATH, started, box)
  const { mounted, worker } = await mountPanel(host, CARRIED_SHEET)
  box.worker = worker

  const card = mounted.find({ type: 'Card', label: 'Start agent' })
  assert.ok(card, 'the carried sheet draws on the detail')
  const readsBeforeConfirm = reads.recordCount.count
  await mounted.select({ label: 'Project' }, PROJECT)
  const confirm = mounted
    .findAll({ type: 'Button', text: 'Start agent' })
    .find((button) => button.path.startsWith(card!.path))
  assert.ok(confirm, 'the sheet confirm stands')
  await mounted.press(confirm!)
  await mounted.settled()
  assert.ok(mounted.find({ type: 'Callout', label: 'The agent was launched.' }), 'the read cost nothing: the launch landed')

  assert.ok(started.press !== null, "Orca started the press's agent from inside workspace.create")
  const decided = await started.press
  assert.equal(decided.kind, 'continue')
  if (decided.kind !== 'continue') return
  assert.deepEqual(
    decided.event.env,
    { KEEP: 'me', TEMPER_TASK: TASK_REF, TEMPER_CONTEXT: CONTEXT },
    'the launch still names the context the press could not: the worker read the record'
  )
  assert.equal(
    reads.recordCount.count,
    readsBeforeConfirm + 1,
    'the launch read the record once: the context the press could not was read before it was held'
  )

  const stored = (host.data().storage['launch-links'] as Record<string, unknown>[]).find(
    (link) => link.itemId === TASK_ID
  )
  assert.ok(stored)
  assert.equal(stored?.contextRef, CONTEXT, 'the link carries the context the read found')
  const markerFile = join(PATH, MARKER)
  assert.ok(existsSync(markerFile))
  const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown>
  assert.equal(marker.context_ref, CONTEXT, 'the marker names it too')

  const later = await worker.hooks.fire('agent.launch.before', hookEvent(`${PROJECT}::${PATH}`))
  assert.equal(later.kind, 'continue')
  if (later.kind !== 'continue') return
  assert.deepEqual(later.event.env, { KEEP: 'me', TEMPER_TASK: TASK_REF, TEMPER_CONTEXT: CONTEXT })
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  await mounted.unmount()
  await worker.deactivate()
})

test('a record read that fails blocks nothing: the launch runs with the context the item arrived with', async () => {
  const PATH = gitFolder()
  const reads = { recordCount: { count: 0 } }
  const temper = fakeTemper(recordView(CONTEXT), reads)
  const started: { press: Promise<HookDecision<'agent.launch.before'>> | null } = { press: null }
  const box: { worker: TestWorker | null } = { worker: null }
  const host = launchHost(PATH, started, box)
  const { mounted, worker } = await mountPanel(host, CARRIED_SHEET)
  box.worker = worker

  const card = mounted.find({ type: 'Card', label: 'Start agent' })
  assert.ok(card)
  await mounted.select({ label: 'Project' }, PROJECT)
  // The read the launch would make refuses: the grant is gone when the press needs it.
  temper.refuse()
  const confirm = mounted
    .findAll({ type: 'Button', text: 'Start agent' })
    .find((button) => button.path.startsWith(card!.path))
  assert.ok(confirm)
  await mounted.press(confirm!)
  await mounted.settled()
  assert.ok(mounted.find({ type: 'Callout', label: 'The agent was launched.' }), 'a failed read never blocks the launch')

  assert.ok(started.press !== null, "Orca started the press's agent")
  const decided = await started.press
  assert.equal(decided.kind, 'continue')
  if (decided.kind !== 'continue') return
  assert.deepEqual(
    decided.event.env,
    { KEEP: 'me', TEMPER_TASK: TASK_REF },
    'nothing is invented: the agent is told the task the press named, and no context beside it'
  )
  const stored = (host.data().storage['launch-links'] as Record<string, unknown>[]).find(
    (link) => link.itemId === TASK_ID
  )
  assert.ok(stored)
  assert.equal(stored?.contextRef, null, 'the link carries no context: none was found')
  await mounted.unmount()
  await worker.deactivate()
})
