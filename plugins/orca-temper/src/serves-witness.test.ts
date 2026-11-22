// The witness `orca_agent_knows_the_task_it_serves`, for the clause `agents-know-what-they-serve`:
// an agent Orca launches into a workspace a Start press linked to a temper task finds the task
// and its context in its environment (`TEMPER_TASK`, `TEMPER_CONTEXT`), and one launched into
// an unlinked workspace finds neither. It drives the plugin as Orca does: a Start launch through
// `temper.launch.go`, with Orca starting the press's agent — and so running its
// `agent.launch.before` hook — from inside `workspace.create`, as Orca 1.4.269 does (the test
// host answers that hook once the launch has answered; ./serves.test.ts drives the hook while
// the launch is still out); then a second agent the person opens later in the same workspace;
// then an agent in another workspace no launch linked. The hook hears each workspace by Orca's own worktree id
// (`<project>::<path>`), not the id `workspace.create` answered. This file imports nothing but
// the worker, so the same file runs against a worker without the hook and fails there.
import { assert, mockHost, mountWorker, test, afterEach, type HookDecision, type TestWorker } from 'orca/testing'
import { deps } from './deps'
import * as main from './worker'

const originalDeps = { ...deps }
afterEach(() => {
  deps.run = originalDeps.run
  deps.runOrca = originalDeps.runOrca
  deps.fetch = originalDeps.fetch
})

const TASK = {
  id: '00000000-0000-7000-8000-0000000000e1',
  ref: 'the-served-task-00000000-0000-7000-8000-0000000000e1',
  title: 'The served task',
  contextRef: '+team/workflows',
  docType: 'task'
}
const PROJECT = 'repo-0001'
const LINKED_PATH = '/work/project/the-served-task'
const LINKED_LIST_ID = 'identity:wt2:local:linked-instance'

function launchEvent(workspaceId: string | null) {
  return {
    agent: 'claude',
    workspaceId,
    workspaceKind: 'worktree' as const,
    command: 'claude',
    env: {} as Record<string, string>
  }
}

test('orca_agent_knows_the_task_it_serves', async () => {
  // No temper read and no CLI run belongs to a launch or its hook.
  deps.run = async () => {
    throw new Error('the temper CLI ran')
  }
  deps.fetch = async () => {
    throw new Error('a temper request went out')
  }
  let worker: TestWorker | null = null
  const started: { pressAgent: Promise<HookDecision<'agent.launch.before'>> | null } = { pressAgent: null }
  const host = mockHost({
    results: {
      'workspace.create': () => {
        // Orca starts the press's agent before it answers the create.
        started.pressAgent = worker!.hooks.fire('agent.launch.before', launchEvent(`${PROJECT}::${LINKED_PATH}`))
        return { workspaceId: LINKED_LIST_ID, terminalId: 't-press' }
      },
      'workspace.list': {
        workspaces: [
          {
            id: LINKED_LIST_ID,
            kind: 'worktree',
            name: 'the-served-task',
            projectId: PROJECT,
            path: LINKED_PATH,
            branch: 'pt/the-served-task',
            hostId: 'local'
          }
        ],
        truncated: false
      }
    }
  })
  worker = await mountWorker(main, { host })

  const launched = await worker.request('temper.launch.go', {
    destination: 'new-workspace',
    projectId: PROJECT,
    agent: 'claude',
    prompt: `You are starting work on a temper task. Start the task: ref \`${TASK.ref}\`, in context \`${TASK.contextRef}\`.`,
    item: TASK
  })
  assert.equal(launched.state, 'launched')

  const served = { TEMPER_TASK: TASK.ref, TEMPER_CONTEXT: TASK.contextRef }
  assert.ok(started.pressAgent !== null, "Orca started the press's agent")
  const press = await started.pressAgent
  assert.equal(press.kind, 'continue')
  if (press.kind !== 'continue') return
  assert.deepEqual(press.event.env, served, "the press's own agent is told the task and its context")

  const later = await worker.hooks.fire('agent.launch.before', launchEvent(`${PROJECT}::${LINKED_PATH}`))
  assert.equal(later.kind, 'continue', 'the hook never refuses a launch')
  if (later.kind !== 'continue') return
  assert.deepEqual(later.event.env, served, 'a later agent in the linked workspace is told the same')

  const elsewhere = await worker.hooks.fire('agent.launch.before', launchEvent(`${PROJECT}::/work/project/unlinked`))
  assert.equal(elsewhere.kind, 'continue')
  if (elsewhere.kind !== 'continue') return
  assert.deepEqual(elsewhere.event.env, {}, 'an agent in an unlinked workspace is told no task')

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
