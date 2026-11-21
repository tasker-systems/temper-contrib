// The launcher's worker side: `temper.launch.go` and the pick reads, over the host mock with
// deps.ts standing in for the CLIs and the network. Pinned here: a new-workspace launch calls
// `workspace.create` with exactly the panel's project, agent and prompt (the press the witness
// `orca_start_names_the_task_and_its_handoff` makes in launcher.test.tsx); the workspace ↔ item
// link lands in the plugin's own storage on success, with the agent and its terminal; a
// refused launch answers with what Orca said and stores nothing; and no press ever calls
// temper — neither the network nor the CLI runs during a launch (Rulings Q3). `agent.launch`
// is not the launcher's (decision ruling 23); only the editor room's "Hand to an agent" sends
// it, pinned here by its this-workspace test. Reopen agent's end: a link learns its
// session only from Orca naming the launch's own terminal, a removed workspace's links are
// dropped, and `temper.reopen.go` calls `agent.resume` with the stored session.
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

const GRANTED = ['settings:own', 'workspace:read', 'workspace:create', 'agent:launch', 'agent:read', 'storage:own']

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
  assert.equal(links[0].agent, 'opencode', 'the link names the agent the launch started')
  assert.equal(links[0].terminalId, 't-new', 'and the terminal its session is learned from')
  assert.equal(links[0].sessionId, undefined, 'no session is guessed at launch')
  assert.deepEqual(host.callsOf('agent.launch'), [], 'a launch never goes through agent.launch')
  assert.equal(temperRuns.count, 0, 'the temper CLI never ran for the launch')
  assert.equal(requests.length, 0, 'no temper request ever went out')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('the editor room\'s this-workspace hand-off calls agent.launch and relinking replaces the pair', async () => {
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

const WORKSPACES = {
  workspaces: [
    { id: 'ws-a', kind: 'worktree', name: 'contrib · pt/the-task', path: '/work/a', branch: 'pt/the-task', hostId: 'local' },
    { id: 'ws-b', kind: 'worktree', name: 'contrib · pt/other', path: '/work/b', branch: 'pt/other', hostId: 'local' }
  ],
  truncated: false
}

function link(workspaceId: string, extra: Record<string, unknown> = {}) {
  return {
    workspaceId,
    itemId: ITEM.id,
    ref: ITEM.ref,
    contextRef: ITEM.contextRef,
    startedAt: '2026-11-20T00:00:00Z',
    ...extra
  }
}

test('an item\'s links are named as Orca lists them, and a gone workspace\'s link is dropped', async () => {
  noTemper()
  const host = mockHost({
    capabilities: GRANTED,
    results: {
      'workspace.list': WORKSPACES,
      'agents.list': { agents: [] }
    },
    storage: {
      'launch-links': [
        link('ws-a', { agent: 'claude', terminalId: 't-a', sessionId: 'sess-a' }),
        link('ws-gone', { agent: 'claude', terminalId: 't-g', sessionId: 'sess-g' }),
        link('ws-b')
      ]
    }
  })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.launch.links', { itemId: ITEM.id })

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.deepEqual(answer.links, [
    { workspaceId: 'ws-a', name: 'contrib · pt/the-task', agent: 'claude', sessionId: 'sess-a' },
    { workspaceId: 'ws-b', name: 'contrib · pt/other', agent: null, sessionId: null }
  ], 'the older link offers no session; the gone workspace is not offered')
  const stored = host.data().storage['launch-links'] as Record<string, unknown>[]
  assert.deepEqual(stored.map((entry) => entry.workspaceId), ['ws-a', 'ws-b'], 'the gone workspace\'s link was dropped')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a link learns its session from agents.list only for the launch\'s own terminal', async () => {
  noTemper()
  const host = mockHost({
    capabilities: GRANTED,
    results: {
      'workspace.list': WORKSPACES,
      'agents.list': {
        agents: [
          { terminalId: 't-other', title: null, agent: 'claude', state: 'working', stateStartedAt: 1, sessionId: 'not-ours' },
          { terminalId: 't-a', title: null, agent: 'claude', state: 'waiting', stateStartedAt: 2, sessionId: 'sess-ours' }
        ]
      }
    },
    storage: { 'launch-links': [link('ws-a', { agent: 'claude', terminalId: 't-a' })] }
  })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.launch.links', { itemId: ITEM.id })

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.equal(answer.links[0]?.sessionId, 'sess-ours', 'the session in the launch\'s own terminal')
  assert.deepEqual(host.callsOf('agents.list'), [{ workspaceId: 'ws-a' }])
  const stored = host.data().storage['launch-links'] as Record<string, unknown>[]
  assert.equal(stored[0]?.sessionId, 'sess-ours', 'the learned session is stored on the link')
  await worker.deactivate()
})

test('agent.status.changed stores the session for the launch\'s terminal, and nothing for another', async () => {
  noTemper()
  const host = mockHost({
    capabilities: GRANTED,
    storage: { 'launch-links': [link('ws-a', { agent: 'claude', terminalId: 't-a' })] }
  })
  const worker = await mountWorker(main, { host })

  await worker.emit('agent.status.changed', {
    workspaceId: 'raw-a',
    workspaceListId: 'ws-a',
    paneKey: 'p-2',
    terminalId: 't-other',
    state: 'working',
    receivedAt: 1,
    sessionId: 'not-ours'
  })
  let stored = host.data().storage['launch-links'] as Record<string, unknown>[]
  assert.equal(stored[0]?.sessionId, undefined, 'another terminal\'s session is never taken')

  await worker.emit('agent.status.changed', {
    workspaceId: 'raw-a',
    workspaceListId: 'ws-a',
    paneKey: 'p-1',
    terminalId: 't-a',
    state: 'working',
    receivedAt: 2,
    sessionId: 'sess-ours'
  })
  stored = host.data().storage['launch-links'] as Record<string, unknown>[]
  assert.equal(stored[0]?.sessionId, 'sess-ours', 'the launch\'s own terminal names its session')
  await worker.deactivate()
})

test('workspace.removed drops every link to that workspace', async () => {
  noTemper()
  const host = mockHost({
    capabilities: GRANTED,
    storage: {
      'launch-links': [
        link('ws-a', { agent: 'claude', terminalId: 't-a', sessionId: 'sess-a' }),
        link('ws-b', { agent: 'claude', terminalId: 't-b', sessionId: 'sess-b' })
      ]
    }
  })
  const worker = await mountWorker(main, { host })

  await worker.emit('workspace.removed', { workspaceId: 'raw-a', workspaceListId: 'ws-a', kind: 'worktree', path: '/work/a' })

  const stored = host.data().storage['launch-links'] as Record<string, unknown>[]
  assert.deepEqual(stored.map((entry) => entry.workspaceId), ['ws-b'], 'only the removed workspace\'s link went')
  await worker.deactivate()
})

test('Reopen agent calls agent.resume with the stored session, and never writes to temper', async () => {
  const { temperRuns, requests } = noTemper()
  const host = mockHost({
    capabilities: GRANTED,
    results: { 'agent.resume': { terminalId: 't-back', started: true } },
    storage: { 'launch-links': [link('ws-a', { agent: 'claude', terminalId: 't-a', sessionId: 'sess-a' })] }
  })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.reopen.go', { itemId: ITEM.id, workspaceId: 'ws-a' })

  assert.deepEqual(answer, { state: 'reopened', terminalId: 't-back', started: true })
  assert.deepEqual(host.callsOf('agent.resume'), [
    { workspaceId: 'ws-a', agent: 'claude', sessionId: 'sess-a' }
  ])
  assert.deepEqual(host.callsOf('agent.launch'), [], 'no temper prompt is sent anywhere')
  assert.deepEqual(host.callsOf('workspace.create'), [])
  assert.equal(temperRuns.count, 0)
  assert.equal(requests.length, 0)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('Reopen agent on a link with no session refuses before any Orca call', async () => {
  noTemper()
  const host = mockHost({
    capabilities: GRANTED,
    storage: { 'launch-links': [link('ws-a')] }
  })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.reopen.go', { itemId: ITEM.id, workspaceId: 'ws-a' })

  assert.equal(answer.state, 'failed')
  assert.deepEqual(host.callsOf('agent.resume'), [], 'no session is guessed')
  await worker.deactivate()
})
