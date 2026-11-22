// The serves marker (./serves-marker.ts) as a launch writes it, over the host mock with real git
// repositories for the workspace folders. Pinned here: a task's launch writes
// `.temper-views/serves.json` with exactly its five fields and no state, after making sure the
// common git dir's `info/exclude` keeps the folder out; a detail press's launch gives the hook
// `TEMPER_CONTEXT` and the link and marker its context; a goal's launch writes none and removes
// one left there; a marker that cannot be written still launches, said in the answer; a create
// that answers Orca's worktree id still links the listed workspace, and the sheet's read after
// the launch keeps that link; and with no stored link, the hook and the strip read the marker.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, mockHost, mountWorker, test, type HookDecision, type TestWorker } from 'orca/testing'
import { deps } from './deps'
import type { LaunchInput } from './protocol'
import * as main from './worker'

const originalDeps = { ...deps }
const folders: string[] = []
afterEach(() => {
  deps.run = originalDeps.run
  deps.fetch = originalDeps.fetch
  for (const dir of folders.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const PROJECT = 'repo-0002'
const LIST_ID = 'identity:wt2:local:marker-instance'
const GRANTED = ['settings:own', 'workspace:read', 'workspace:create', 'agent:launch', 'agent:read', 'storage:own']
const MARKER = join('.temper-views', 'serves.json')

/** A task as its detail names it — what the detail's Start press sends (`DetailLaunchButton`). */
const DETAIL_TASK = {
  id: '00000000-0000-7000-8000-0000000000c1',
  ref: 'the-marked-task-00000000-0000-7000-8000-0000000000c1',
  title: 'The marked task',
  contextRef: '+team/marked',
  docType: 'task'
}
const GOAL = {
  id: '00000000-0000-7000-8000-0000000000c2',
  ref: 'the-goal-00000000-0000-7000-8000-0000000000c2',
  title: 'The goal',
  contextRef: '+team/marked',
  docType: 'goal'
}

function gitFolder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-temper-marker-')))
  folders.push(dir)
  execFileSync('git', ['init', '--quiet', dir])
  return dir
}

function noTemper(): void {
  deps.run = async () => {
    throw new Error('the temper CLI ran')
  }
  deps.fetch = async () => {
    throw new Error('a temper request went out')
  }
}

function input(item: LaunchInput['item']): LaunchInput {
  return {
    destination: 'new-workspace',
    projectId: PROJECT,
    agent: 'claude',
    prompt: `Start the item: ref \`${item.ref}\`, in context \`${item.contextRef}\`.`,
    item
  }
}

function launchEvent(workspaceId: string) {
  return { agent: 'claude', workspaceId, workspaceKind: 'worktree' as const, command: 'claude', env: {} as Record<string, string> }
}

/** A host whose create starts the press's agent (its hook) before answering, as Orca does. */
function hostFor(folder: string, created: { workspaceId: string } = { workspaceId: LIST_ID }) {
  let worker: TestWorker | null = null
  const started: { press: Promise<HookDecision<'agent.launch.before'>> | null } = { press: null }
  const host = mockHost({
    capabilities: GRANTED,
    results: {
      'workspace.create': () => {
        started.press = worker!.hooks.fire('agent.launch.before', launchEvent(`${PROJECT}::${folder}`))
        return { ...created, terminalId: 't-press' }
      },
      'workspace.list': {
        workspaces: [
          { id: LIST_ID, kind: 'worktree', name: 'marked', projectId: PROJECT, path: folder, branch: 'b', hostId: 'local' }
        ],
        truncated: false
      }
    }
  })
  return {
    host,
    started,
    mount: async () => {
      worker = await mountWorker(main, { host })
      return worker
    }
  }
}

test("a task's launch writes the marker's five fields, no state, with the folder kept out of git", async () => {
  noTemper()
  const folder = gitFolder()
  const { mount } = hostFor(folder)
  const worker = await mount()

  const answer = await worker.request('temper.launch.go', input(DETAIL_TASK))

  assert.equal(answer.state, 'launched')
  if (answer.state !== 'launched') return
  assert.equal(answer.markerError, null)
  const marker = JSON.parse(readFileSync(join(folder, MARKER), 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(marker).sort(), ['context_ref', 'task_id', 'task_ref', 'title', 'written_at'])
  assert.equal(marker.task_ref, DETAIL_TASK.ref)
  assert.equal(marker.task_id, DETAIL_TASK.id)
  assert.equal(marker.context_ref, DETAIL_TASK.contextRef)
  assert.equal(marker.title, DETAIL_TASK.title)
  assert.ok(!Number.isNaN(Date.parse(String(marker.written_at))))
  for (const state of ['stage', 'status', 'claim_id', 'state', 'heartbeat_at']) {
    assert.ok(!(state in marker), `the marker carries no ${state}`)
  }
  const exclude = readFileSync(join(folder, '.git', 'info', 'exclude'), 'utf8')
  assert.ok(exclude.split('\n').includes('.temper-views/'), 'the common git dir excludes .temper-views/')
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: folder, encoding: 'utf8' }), '', 'git sees nothing new')
  await worker.deactivate()
})

test("a detail press's launch gives TEMPER_CONTEXT, and its link and marker carry the context", async () => {
  noTemper()
  const folder = gitFolder()
  const { host, started, mount } = hostFor(folder)
  const worker = await mount()

  const answer = await worker.request('temper.launch.go', input(DETAIL_TASK))
  assert.equal(answer.state, 'launched')

  assert.ok(started.press !== null)
  const press = await started.press
  assert.equal(press.kind, 'continue')
  if (press.kind !== 'continue') return
  assert.deepEqual(press.event.env, { TEMPER_TASK: DETAIL_TASK.ref, TEMPER_CONTEXT: DETAIL_TASK.contextRef })
  const later = await worker.hooks.fire('agent.launch.before', launchEvent(`${PROJECT}::${folder}`))
  assert.equal(later.kind, 'continue')
  if (later.kind !== 'continue') return
  assert.deepEqual(later.event.env, { TEMPER_TASK: DETAIL_TASK.ref, TEMPER_CONTEXT: DETAIL_TASK.contextRef })
  const [stored] = host.data().storage['launch-links'] as Record<string, unknown>[]
  assert.equal(stored?.contextRef, DETAIL_TASK.contextRef)
  const marker = JSON.parse(readFileSync(join(folder, MARKER), 'utf8')) as Record<string, unknown>
  assert.equal(marker.context_ref, DETAIL_TASK.contextRef)
  await worker.deactivate()
})

test("a goal's launch writes no marker, and removes one left in the folder", async () => {
  noTemper()
  const folder = gitFolder()
  mkdirSync(join(folder, '.temper-views'))
  writeFileSync(join(folder, MARKER), JSON.stringify({ task_ref: 'stale', task_id: 'stale' }))
  const { mount } = hostFor(folder)
  const worker = await mount()

  const answer = await worker.request('temper.launch.go', input(GOAL))

  assert.equal(answer.state, 'launched')
  if (answer.state !== 'launched') return
  assert.equal(answer.markerError, null)
  assert.ok(!existsSync(join(folder, MARKER)), 'no marker stands in a goal-started workspace')
  await worker.deactivate()
})

test('a marker that cannot be written still launches, said in the answer, with the link stored', async () => {
  noTemper()
  const tracked = gitFolder()
  mkdirSync(join(tracked, '.temper-views'))
  writeFileSync(join(tracked, '.temper-views', 'kept.md'), 'tracked\n')
  execFileSync('git', ['add', '.temper-views/kept.md'], { cwd: tracked })
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'orca-temper-plain-')))
  folders.push(plain)

  for (const folder of [tracked, plain]) {
    const { host, mount } = hostFor(folder)
    const worker = await mount()
    const answer = await worker.request('temper.launch.go', input(DETAIL_TASK))
    assert.equal(answer.state, 'launched', 'the launch stands')
    if (answer.state !== 'launched') return
    assert.ok(
      typeof answer.markerError === 'string' && answer.markerError.startsWith('the serves marker was not written'),
      `the answer says why: ${String(answer.markerError)}`
    )
    assert.ok(!existsSync(join(folder, MARKER)))
    assert.equal((host.data().storage['launch-links'] as unknown[]).length, 1, 'the link was stored all the same')
    await worker.deactivate()
  }
})

test("a create answering Orca's worktree id links the listed workspace, and the sheet's read keeps it", async () => {
  noTemper()
  const folder = gitFolder()
  const { host, mount } = hostFor(folder, { workspaceId: `${PROJECT}::${folder}` })
  const worker = await mount()

  const answer = await worker.request('temper.launch.go', input(DETAIL_TASK))
  assert.equal(answer.state, 'launched')
  if (answer.state !== 'launched') return
  assert.equal(answer.workspaceName, 'marked', 'the workspace is named as Orca lists it')
  const links = await worker.request('temper.launch.links', { itemId: DETAIL_TASK.id })
  assert.deepEqual(links, { state: 'ok', links: [{ workspaceId: LIST_ID, name: 'marked', agent: 'claude', sessionId: null }] })
  const stored = host.data().storage['launch-links'] as Record<string, unknown>[]
  assert.equal(stored.length, 1, 'the link survived the read after the launch')
  assert.equal(stored[0]?.workspaceId, LIST_ID)
  assert.equal(stored[0]?.path, folder)
  await worker.deactivate()
})

test('with no stored link, the hook and the strip read the workspace marker', async () => {
  noTemper()
  const folder = gitFolder()
  mkdirSync(join(folder, '.temper-views'))
  writeFileSync(
    join(folder, MARKER),
    JSON.stringify({
      task_ref: DETAIL_TASK.ref,
      task_id: DETAIL_TASK.id,
      context_ref: DETAIL_TASK.contextRef,
      title: DETAIL_TASK.title,
      written_at: '2026-11-22T00:00:00.000Z'
    })
  )
  const { mount } = hostFor(folder)
  const worker = await mount()

  const hook = await worker.hooks.fire('agent.launch.before', launchEvent(`${PROJECT}::${folder}`))
  assert.equal(hook.kind, 'continue')
  if (hook.kind !== 'continue') return
  assert.deepEqual(hook.event.env, { TEMPER_TASK: DETAIL_TASK.ref, TEMPER_CONTEXT: DETAIL_TASK.contextRef })

  const served = await worker.request('temper.serves', { workspaceId: LIST_ID })
  assert.equal(served.state, 'linked')
  if (served.state !== 'linked') return
  assert.deepEqual(served.item, {
    itemId: DETAIL_TASK.id,
    ref: DETAIL_TASK.ref,
    title: DETAIL_TASK.title,
    docType: 'task',
    contextRef: DETAIL_TASK.contextRef
  })
  assert.notEqual(served.record.state, 'ok', "no read answered, so no stage is shown: it comes only from temper's read")
  await worker.deactivate()
})

test('a stored link to a goal stands over a marker left in the folder: the hook adds nothing', async () => {
  noTemper()
  const folder = gitFolder()
  mkdirSync(join(folder, '.temper-views'))
  writeFileSync(join(folder, MARKER), JSON.stringify({ task_ref: DETAIL_TASK.ref, task_id: DETAIL_TASK.id }))
  const host = mockHost({
    capabilities: GRANTED,
    storage: {
      'launch-links': [
        { workspaceId: LIST_ID, itemId: GOAL.id, ref: GOAL.ref, contextRef: GOAL.contextRef, startedAt: '2026-11-22T00:00:00Z', docType: 'goal', projectId: PROJECT, path: folder }
      ]
    }
  })
  const worker = await mountWorker(main, { host })

  const hook = await worker.hooks.fire('agent.launch.before', launchEvent(`${PROJECT}::${folder}`))
  assert.equal(hook.kind, 'continue')
  if (hook.kind !== 'continue') return
  assert.deepEqual(hook.event.env, {})
  await worker.deactivate()
})
