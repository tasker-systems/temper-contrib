// The witness `orca_agent_knows_the_task_it_serves`, for the clause `agents-know-what-they-serve`:
// an agent Orca launches into a workspace a Start press linked to a temper task finds the task
// and its context in its environment (`TEMPER_TASK`, `TEMPER_CONTEXT`), and one launched into
// an unlinked workspace finds neither. It drives the plugin as Orca does: a Start launch through
// `temper.launch.go`, with Orca starting the press's agent — and so running its
// `agent.launch.before` hook — from inside `workspace.create`, as Orca 1.4.269 does (the test
// host answers that hook once the launch has answered; ./serves.test.ts drives the hook while
// the launch is still out); then a second agent the person opens later in the same workspace;
// then an agent in another workspace no launch linked. The hook hears each workspace by Orca's own worktree id
// (`<project>::<path>`), not the id `workspace.create` answered. Decision ruling 27 adds the
// marker: after the launch, the linked workspace's folder holds `.temper-views/serves.json`
// naming the task and its context, which any agent there can read (a chat agent the hook never
// reaches among them), and the unlinked workspace's folder holds none. Both folders are real git
// repositories. This file imports nothing of the plugin's but the worker, so the same file runs
// against a worker without the hook or the marker and fails there.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const LINKED_LIST_ID = 'identity:wt2:local:linked-instance'

const folders: string[] = []
afterEach(() => {
  for (const dir of folders.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A fresh git repository standing in for one workspace's folder. */
function gitFolder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-temper-witness-')))
  folders.push(dir)
  execFileSync('git', ['init', '--quiet', dir])
  return dir
}
const MARKER = join('.temper-views', 'serves.json')

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
  const LINKED_PATH = gitFolder()
  const UNLINKED_PATH = gitFolder()
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

  const elsewhere = await worker.hooks.fire('agent.launch.before', launchEvent(`${PROJECT}::${UNLINKED_PATH}`))
  assert.equal(elsewhere.kind, 'continue')
  if (elsewhere.kind !== 'continue') return
  assert.deepEqual(elsewhere.event.env, {}, 'an agent in an unlinked workspace is told no task')

  // Any agent in the workspace — chat, terminal, another harness — reads the same in its folder.
  const markerFile = join(LINKED_PATH, MARKER)
  assert.ok(existsSync(markerFile), 'the linked workspace holds a serves marker')
  const marker = JSON.parse(readFileSync(markerFile, 'utf8')) as Record<string, unknown>
  assert.equal(marker.task_ref, TASK.ref, 'the marker names the task')
  assert.equal(marker.task_id, TASK.id)
  assert.equal(marker.context_ref, TASK.contextRef, 'and its context')
  assert.ok(!existsSync(join(UNLINKED_PATH, MARKER)), 'an unlinked workspace holds no marker')

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
