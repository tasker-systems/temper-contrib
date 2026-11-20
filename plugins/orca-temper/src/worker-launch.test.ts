// The launcher's worker side: `temper.launch.go` and the pick reads, over the host mock with
// deps.ts standing in for the CLIs and the network. Pinned here: a new-workspace launch calls
// `workspace.create` with exactly the panel's project, agent and prompt (the press the witness
// `orca_start_names_the_task_and_its_handoff` makes in launcher.test.tsx); Resume in this
// workspace calls `agent.launch`; the workspace ↔ item link lands in the plugin's own storage
// on success; a refused launch answers with what Orca said and stores nothing; and no press
// ever calls temper — neither the network nor the CLI runs during a launch (Rulings Q3).
import { assert, mockHost, mountWorker, test, afterEach } from 'orca/testing'
import { deps, type CommandResult } from './deps'
import * as main from './worker'
import type { LaunchInput } from './protocol'

const originalDeps = { ...deps }
afterEach(() => {
  deps.run = originalDeps.run
  deps.runOrca = originalDeps.runOrca
  deps.fetch = originalDeps.fetch
})

const ITEM = {
  id: '00000000-0000-7000-8000-0000000000d1',
  ref: 'the-launch-task-00000000-0000-7000-8000-0000000000d1',
  title: 'The item detail',
  contextRef: '+temper-dev/contrib-workflows'
}
const PROMPT = `You are starting work on a temper task. Start the task: ref \`${ITEM.ref}\`, in context \`${ITEM.contextRef}\`.`

const GRANTED = ['settings:own', 'workspace:read', 'workspace:create', 'agent:launch', 'storage:own']

function launchInput(overrides: Partial<LaunchInput> = {}): LaunchInput {
  return {
    destination: 'new-workspace',
    projectId: 'proj-two',
    agent: 'opencode',
    prompt: PROMPT,
    item: ITEM,
    ...overrides
  }
}

/** The temper side must stay untouched by a launch: count every approach to it. */
function noTemper(): { temperRuns: { count: number }; requests: Request[] } {
  const temperRuns = { count: 0 }
  const requests: Request[] = []
  deps.run = async () => {
    temperRuns.count += 1
    return { code: 0, stdout: '', stderr: '' }
  }
  deps.fetch = async (input: Request) => {
    requests.push(input)
    return new Response('{}', { status: 200 })
  }
  return { temperRuns, requests }
}

test('a new-workspace launch calls workspace.create with the project, agent and prompt, and the link lands in storage', async () => {
  const { temperRuns, requests } = noTemper()
  let built: unknown = null
  const host = mockHost({
    capabilities: GRANTED,
    results: {
      'workspace.create': (params: unknown) => {
        built = params
        return { workspaceId: 'ws-new', terminalId: 't-new' }
      }
    }
  })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.launch.go', launchInput())

  assert.equal(answer.state, 'launched')
  if (answer.state !== 'launched') return
  assert.equal(answer.workspaceId, 'ws-new')
  assert.deepEqual(built, {
    projectId: 'proj-two',
    agent: 'opencode',
    prompt: PROMPT
  })
  const links = host.data().storage['launch-links'] as Record<string, unknown>[]
  assert.equal(links.length, 1, 'one link landed in the plugin\'s own storage')
  assert.equal(links[0].workspaceId, 'ws-new')
  assert.equal(links[0].itemId, ITEM.id)
  assert.equal(links[0].ref, ITEM.ref)
  assert.equal(links[0].contextRef, ITEM.contextRef)
  assert.ok(typeof links[0].startedAt === 'string')
  assert.equal(temperRuns.count, 0, 'the temper CLI never ran for the launch')
  assert.equal(requests.length, 0, 'no temper request ever went out')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('resume in this workspace calls agent.launch and relinking replaces the pair', async () => {
  const { temperRuns, requests } = noTemper()
  const host = mockHost({
    capabilities: GRANTED,
    results: {
      'agent.launch': { terminalId: 't-here' }
    },
    storage: {
      'launch-links': [
        { workspaceId: 'ws-current', itemId: ITEM.id, ref: ITEM.ref, contextRef: ITEM.contextRef, startedAt: '2026-11-19T00:00:00Z' },
        { workspaceId: 'ws-other', itemId: ITEM.id, ref: ITEM.ref, contextRef: ITEM.contextRef, startedAt: '2026-11-18T00:00:00Z' }
      ]
    }
  })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request(
    'temper.launch.go',
    launchInput({ destination: 'this-workspace', workspaceId: 'ws-current', projectId: undefined })
  )

  assert.equal(answer.state, 'launched')
  if (answer.state !== 'launched') return
  assert.equal(answer.workspaceId, 'ws-current')
  assert.equal(answer.terminalId, 't-here')
  assert.deepEqual(host.callsOf('agent.launch'), [
    { workspaceId: 'ws-current', agent: 'opencode', prompt: PROMPT }
  ])
  assert.deepEqual(host.callsOf('workspace.create'), [], 'no workspace was created')
  const links = host.data().storage['launch-links'] as Record<string, unknown>[]
  assert.equal(links.length, 2, 'the relaunched pair was replaced, the other workspace kept')
  const here = links.find((link) => link.workspaceId === 'ws-current')
  assert.ok(here && here.startedAt !== '2026-11-19T00:00:00Z', 'the link was refreshed')
  assert.equal(temperRuns.count, 0)
  assert.equal(requests.length, 0)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a refused launch answers with what Orca said and stores nothing', async () => {
  const { temperRuns, requests } = noTemper()
  const host = mockHost({
    capabilities: GRANTED.filter((kind) => kind !== 'workspace:create'),
    results: {
      'workspace.create': { workspaceId: 'ws-new', terminalId: 't-new' }
    }
  })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.launch.go', launchInput())

  assert.equal(answer.state, 'refused', 'the refusal rides back as what Orca said')
  if (answer.state !== 'refused') return
  assert.equal(answer.code, 'capability_denied')
  assert.ok(answer.message.length > 0)
  assert.equal(host.data().storage['launch-links'], undefined, 'nothing was stored for a refused launch')
  assert.equal(temperRuns.count, 0)
  assert.equal(requests.length, 0)
  await worker.deactivate()
})

test('a bad launch input fails before any Orca call', async () => {
  const host = mockHost({ capabilities: GRANTED })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.launch.go', launchInput({ projectId: '' }))

  assert.equal(answer.state, 'failed')
  assert.deepEqual(host.callsOf('workspace.create'), [])
  assert.deepEqual(host.callsOf('agent.launch'), [])
  await worker.deactivate()
})

test('the projects pick is Orca\'s list with hidden projects left out', async () => {
  const host = mockHost({
    capabilities: GRANTED,
    results: {
      'project.list': {
        projects: [
          { id: 'proj-one', name: 'temper', kind: 'git', hostId: 'local', path: '/work/temper' },
          { id: 'proj-two', name: 'secret', kind: 'git', hostId: 'local', path: '/work/secret', hidden: true }
        ],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.launch.projects')

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.deepEqual(answer.projects, [
    { id: 'proj-one', name: 'temper', path: '/work/temper', hostId: 'local' }
  ])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('the agents pick is what Orca\'s own CLI says this host can launch', async () => {
  const cliAnswer: CommandResult = {
    code: 0,
    stdout: JSON.stringify({
      id: 'x',
      ok: true,
      result: {
        agents: [
          { id: 'claude', name: 'Claude', default: true },
          { id: 'opencode', name: 'OpenCode', default: false },
          { id: 'odd-one' }
        ]
      }
    }),
    stderr: ''
  }
  deps.runOrca = async () => cliAnswer
  const host = mockHost({ capabilities: GRANTED })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.launch.agents')

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.deepEqual(answer.agents, [
    { id: 'claude', name: 'Claude', isDefault: true },
    { id: 'opencode', name: 'OpenCode', isDefault: false },
    { id: 'odd-one', name: 'odd-one', isDefault: false }
  ])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('when Orca will not name its agents the pick fails with what the CLI said', async () => {
  deps.runOrca = async () => ({ code: 1, stdout: '', stderr: 'no Orca runtime is running' })
  const host = mockHost({ capabilities: GRANTED })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.launch.agents')

  assert.equal(answer.state, 'failed')
  if (answer.state !== 'failed') return
  assert.match(answer.message, /no Orca runtime is running/)
  await worker.deactivate()
})
