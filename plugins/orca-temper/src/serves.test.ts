// What a workspace serves, worker side (./serves.ts), beside the witness in
// ./serves-witness.test.ts. Pinned here: the hook matches a link by either of Orca's workspace
// ids and takes the newest; only a link to a task gives `TEMPER_TASK`/`TEMPER_CONTEXT`; a
// launch still out to `workspace.create` answers the hook from memory with no host call, and
// two items pending in one project give nothing; a storage refusal adds nothing and refuses no
// launch. `temper.serves` names the stored link, reads its record on the grant, and teaches an
// older link its doc type, title, project and path; signed out, the link still stands; a
// launch stores the doc type, title, project and path it knows.
import { assert, mockHost, mountWorker, test, afterEach } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { deps } from './deps'
import type { Gate } from './editor-room/open-body'
import type { LaunchLink } from './protocol'
import {
  CONTEXT_ENV,
  pendingFor,
  registerServes,
  servingLink,
  taskEnv,
  TASK_ENV,
  worktreeIdOf,
  type PendingLaunch
} from './serves'
import * as main from './worker'

const originalDeps = { ...deps }
afterEach(() => {
  deps.run = originalDeps.run
  deps.fetch = originalDeps.fetch
})

const TASK_ID = '00000000-0000-7000-8000-0000000000f1'
const GOAL_ID = '00000000-0000-7000-8000-0000000000f2'
const CONTEXT = '+team/workflows'

function link(overrides: Partial<LaunchLink> = {}): LaunchLink {
  return {
    workspaceId: 'identity:wt2:local:one',
    itemId: TASK_ID,
    ref: `the-task-${TASK_ID}`,
    contextRef: CONTEXT,
    startedAt: '2026-11-21T10:00:00Z',
    docType: 'task',
    projectId: 'repo-1',
    path: '/w/one',
    ...overrides
  }
}

function event(workspaceId: string | null, agent = 'claude') {
  return { agent, workspaceId, workspaceKind: 'worktree' as const, command: agent, env: { KEEP: 'me' } as Record<string, string> }
}

test("a link matches Orca's worktree id or the listed id, and the newest link wins", () => {
  assert.equal(worktreeIdOf(link()), 'repo-1::/w/one')
  assert.equal(worktreeIdOf(link({ path: undefined })), null)
  const older = link({ startedAt: '2026-11-20T00:00:00Z', ref: 'older' })
  const newer = link({ startedAt: '2026-11-21T00:00:00Z', ref: 'newer' })
  assert.equal(servingLink([older, newer], 'repo-1::/w/one')?.ref, 'newer')
  assert.equal(servingLink([newer, older], 'identity:wt2:local:one')?.ref, 'newer')
  assert.equal(servingLink([older], 'repo-1::/w/two'), null)
})

test('only a link to a task tells an agent its task and context', () => {
  assert.deepEqual(taskEnv(link()), { [TASK_ENV]: `the-task-${TASK_ID}`, [CONTEXT_ENV]: CONTEXT })
  assert.deepEqual(taskEnv(link({ contextRef: null })), { [TASK_ENV]: `the-task-${TASK_ID}` })
  assert.deepEqual(taskEnv(link({ ref: '' })), { [TASK_ENV]: TASK_ID, [CONTEXT_ENV]: CONTEXT })
  assert.deepEqual(taskEnv(link({ docType: 'goal', itemId: GOAL_ID })), {}, 'a goal is not a task')
  assert.deepEqual(taskEnv(link({ docType: 'session' })), {}, 'nor is a handoff session')
  assert.deepEqual(taskEnv(link({ docType: undefined })), {}, 'an unnamed doc type vouches for nothing')
})

test('a pending launch answers only for its own project and agent, and never between two items', () => {
  const one: PendingLaunch = { projectId: 'repo-1', agent: 'claude', link: link() }
  const sameItem: PendingLaunch = { projectId: 'repo-1', agent: 'claude', link: link() }
  const other: PendingLaunch = { projectId: 'repo-1', agent: 'claude', link: link({ itemId: GOAL_ID }) }
  assert.equal(pendingFor([one], event('repo-1::/w/new'))?.itemId, TASK_ID)
  assert.equal(pendingFor([one, sameItem], event('repo-1::/w/new'))?.itemId, TASK_ID)
  assert.equal(pendingFor([one], event('repo-2::/w/new')), null, 'another project')
  assert.equal(pendingFor([one], event('repo-1::/w/new', 'codex')), null, 'another agent')
  assert.equal(pendingFor([one, other], event('repo-1::/w/new')), null, 'two items: no guess')
  assert.equal(pendingFor([one], event(null)), null)
})

/** A worker stand-in holding only what registerServes touches; its storage never answers. */
function hookOnly(storage: () => Promise<unknown>) {
  let hook: ((e: ReturnType<typeof event>, next: (e?: unknown) => unknown) => Promise<unknown>) | null = null
  const calls: string[] = []
  const orca = {
    hooks: {
      on: (_name: string, handler: typeof hook) => {
        hook = handler
        return { dispose() {} }
      }
    },
    panels: { handle: () => ({ dispose() {} }) },
    storage: {
      get: async () => {
        calls.push('storage.get')
        return storage()
      }
    },
    host: { call: async (method: string) => { calls.push(method); throw new Error('no host here') }, has: () => false }
  } as unknown as OrcaWorkerApi
  const gate: Gate = async () => ({ state: 'not-connected', message: 'unused' })
  return { orca, gate, calls, fire: (e: ReturnType<typeof event>) => hook!(e, (next) => next ?? e) }
}

test('while the launch is still out, the hook answers from memory and makes no host call', async () => {
  const stand = hookOnly(() => new Promise(() => {}))
  const pending = new Set<PendingLaunch>([{ projectId: 'repo-1', agent: 'claude', link: link() }])
  registerServes(stand.orca, stand.gate, pending)
  const decided = (await stand.fire(event('repo-1::/w/new'))) as ReturnType<typeof event>
  assert.deepEqual(decided.env, { KEEP: 'me', [TASK_ENV]: `the-task-${TASK_ID}`, [CONTEXT_ENV]: CONTEXT })
  assert.deepEqual(stand.calls, [], 'no storage read, no host call')
})

test('a stored link to a goal, or a storage refusal, adds nothing and refuses no launch', async () => {
  const goal = hookOnly(async () => [link({ docType: 'goal', itemId: GOAL_ID })])
  registerServes(goal.orca, goal.gate, new Set())
  assert.deepEqual(((await goal.fire(event('repo-1::/w/one'))) as ReturnType<typeof event>).env, { KEEP: 'me' })

  const refused = hookOnly(async () => {
    throw new Error('capability_denied')
  })
  registerServes(refused.orca, refused.gate, new Set())
  assert.deepEqual(((await refused.fire(event('repo-1::/w/one'))) as ReturnType<typeof event>).env, { KEEP: 'me' })

  const nowhere = hookOnly(async () => [link()])
  registerServes(nowhere.orca, nowhere.gate, new Set())
  assert.deepEqual(((await nowhere.fire(event(null))) as ReturnType<typeof event>).env, { KEEP: 'me' })
  assert.deepEqual(nowhere.calls, [], 'an agent in no workspace reads nothing')
})

const TOKEN = (() => {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'none' })}.${encode({ exp: 4_102_444_800 })}.sig`
})()

const RECORD_VIEW = {
  id: TASK_ID,
  ref: `the-task-${TASK_ID}`,
  title: 'The served task',
  doc_type_name: 'task',
  created: '2026-11-01T00:00:00Z',
  updated: '2026-11-20T01:00:00Z',
  is_active: true,
  origin_uri: '',
  originator_profile_id: '019d0000-0000-7000-8000-000000000000',
  owner_profile_id: '019d0000-0000-7000-8000-000000000000',
  owner_handle: 'fixture-owner',
  context_name: 'workflows',
  context_owner_ref: '+team',
  context_slug: 'workflows',
  context_ref: CONTEXT,
  cogmap_name: null,
  managed_meta: { 'temper-stage': 'in-progress' }
}

const LIST = {
  workspaces: [
    { id: 'identity:wt2:local:one', kind: 'worktree', name: 'the-task', projectId: 'repo-1', path: '/w/one', branch: 'b', hostId: 'local' }
  ],
  truncated: false
}

test('temper.serves names the stored link and its record, and teaches an older link what it lacks', async () => {
  deps.run = async () => ({ code: 0, stdout: `${TOKEN}\n`, stderr: '' })
  deps.fetch = async () =>
    new Response(JSON.stringify(RECORD_VIEW), { status: 200, headers: { 'content-type': 'application/json' } })
  const older = { workspaceId: 'identity:wt2:local:one', itemId: TASK_ID, ref: RECORD_VIEW.ref, contextRef: CONTEXT, startedAt: '2026-11-21T10:00:00Z', sessionId: 's-1' }
  const host = mockHost({
    settings: { apiUrl: 'https://temper.example' },
    storage: { 'launch-links': [older] },
    results: { 'workspace.list': LIST }
  })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.serves', { workspaceId: 'identity:wt2:local:one' })
  assert.equal(answer.state, 'linked')
  if (answer.state !== 'linked') return
  assert.equal(answer.item.itemId, TASK_ID)
  assert.equal(answer.record.state, 'ok')
  if (answer.record.state !== 'ok') return
  assert.equal(answer.record.detail.stage, 'in-progress')
  assert.equal(answer.item.docType, 'task')

  const stored = (host.data().storage['launch-links'] as Record<string, unknown>[])[0]
  assert.equal(stored?.docType, 'task', 'the doc type is learned from the record')
  assert.equal(stored?.title, 'The served task')
  assert.equal(stored?.projectId, 'repo-1', 'the project and path from workspace.list')
  assert.equal(stored?.path, '/w/one')
  assert.equal(stored?.sessionId, 's-1', 'what the link already held is kept')

  const env = await worker.hooks.fire('agent.launch.before', event('repo-1::/w/one'))
  assert.equal(env.kind, 'continue')
  if (env.kind !== 'continue') return
  assert.equal(env.event.env[TASK_ENV], RECORD_VIEW.ref, 'the taught link is hook-ready')

  assert.deepEqual(await worker.request('temper.serves', { workspaceId: 'identity:wt2:local:two' }), { state: 'unlinked' })
  assert.equal((await worker.request('temper.serves', { workspaceId: '' })).state, 'failed')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('signed out, temper.serves still names the link by what it stored, and reads no record', async () => {
  const requests: Request[] = []
  deps.run = async () => ({ code: 1, stdout: '{"code":"UNAUTHENTICATED"}', stderr: '' })
  deps.fetch = async (input: Request) => {
    requests.push(input)
    return new Response('{}', { status: 200 })
  }
  const host = mockHost({
    storage: { 'launch-links': JSON.parse(JSON.stringify([link({ title: 'The served task' })])) },
    results: { 'workspace.list': LIST }
  })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.serves', { workspaceId: 'identity:wt2:local:one' })
  assert.equal(answer.state, 'linked')
  if (answer.state !== 'linked') return
  assert.equal(answer.record.state, 'not-connected')
  assert.equal(answer.item.title, 'The served task')
  assert.equal(answer.item.docType, 'task')
  assert.equal(requests.length, 0)
  await worker.deactivate()
})

test('a launch stores the doc type, title, project and path it knows', async () => {
  deps.run = async () => {
    throw new Error('the temper CLI ran')
  }
  const host = mockHost({
    results: {
      'workspace.create': { workspaceId: 'identity:wt2:local:one', terminalId: 't-1' },
      'workspace.list': LIST
    }
  })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.launch.go', {
    destination: 'new-workspace',
    projectId: 'repo-1',
    agent: 'claude',
    prompt: 'Start the task.',
    item: { id: TASK_ID, ref: RECORD_VIEW.ref, title: 'The served task', contextRef: CONTEXT, docType: 'task' }
  })
  assert.equal(answer.state, 'launched')
  const stored = (host.data().storage['launch-links'] as Record<string, unknown>[])[0]
  assert.equal(stored?.docType, 'task')
  assert.equal(stored?.title, 'The served task')
  assert.equal(stored?.projectId, 'repo-1')
  assert.equal(stored?.path, '/w/one')
  assert.equal(stored?.terminalId, 't-1')
  await worker.deactivate()
})
