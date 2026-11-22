// Home's "this workspace" strip (./serves-strip.tsx), mounted with the whole panel. Pinned
// here: a linked workspace names its task by title, stage and ref, and its agents by their
// status words; pressing the task opens its detail; an unlinked workspace says it serves no
// temper task; a link to something else says the same and names what it was started from; no
// focused workspace says so; a withheld consent names itself and no Orca read is made; a focus
// change reads what the new workspace serves; and an agent's status change reads its agents.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { ServesOutput } from './protocol'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

const ALL = ['settings:own', 'workspace:read', 'workspace:create', 'agent:launch', 'agent:read', 'storage:own', 'workspace:write']
const TASK_ID = '00000000-0000-7000-8000-0000000000c1'
const TASK_REF = `the-served-task-${TASK_ID}`
const LINKED = 'identity:wt2:local:linked'

const HOME = {
  'temper.home.resume': () => ({ state: 'ok' as const, resume: null }),
  'temper.home.handoff': () => ({ state: 'ok' as const, sessionCount: 0, handoff: null }),
  'temper.home.way-in': (input: { id: string; bound: number }) => ({
    state: 'ok' as const, id: input.id, label: input.id, scope: input.id, rows: [], total: 0, bound: input.bound
  }),
  'temper.home.places': () => ({ state: 'ok' as const, rows: [], total: 0 }),
  'temper.home.recent': () => ({ state: 'ok' as const, rows: [], total: 0 }),
  'temper.launch.links': () => ({ state: 'ok' as const, links: [] })
}

const DETAIL = {
  id: TASK_ID,
  ref: TASK_REF,
  title: 'The served task',
  docType: 'task',
  stage: 'in-progress',
  status: null,
  contextRef: '+team/workflows',
  properties: [{ label: 'doc_type', value: 'task' }]
}

const linkedAnswer = (docType = 'task') => ({
  state: 'linked' as const,
  item: { itemId: TASK_ID, ref: TASK_REF, title: 'The served task', docType, contextRef: '+team/workflows' },
  record: { state: 'ok' as const, detail: { ...DETAIL, docType, stage: docType === 'task' ? 'in-progress' : null, status: docType === 'goal' ? 'active' : null } }
})

const context = (workspaceId: string) => ({ workspaceId, branch: 'pt/the-served-task', displayName: 'the-served-task', terminals: [] })

function host(options: { granted?: string[]; serves?: (input: { workspaceId: string }) => ServesOutput; context?: unknown; agents?: unknown }) {
  const granted = options.granted ?? ALL
  return mockHost({
    capabilities: granted,
    requests: {
      ...HOME,
      'temper.capabilities': () => ({ granted }),
      'temper.serves': options.serves ?? (() => linkedAnswer()),
      'temper.resource.detail': () => ({ state: 'ok' as const, detail: DETAIL })
    },
    results: {
      'workspace.readContext': options.context === undefined ? context(LINKED) : options.context,
      'agents.list': options.agents ?? {
        agents: [
          { terminalId: 't-1', title: 'Claude', agent: 'claude', state: 'working', stateStartedAt: Date.now() - 120_000, sessionId: null, task: null },
          { terminalId: 't-2', title: null, agent: 'codex', state: 'done', stateStartedAt: Date.now() - 3_600_000 }
        ]
      }
    }
  })
}

test('a linked workspace names its task, its stage and ref, and its agents by status word', async () => {
  const asked: string[] = []
  mounted = await mount(panel, {
    host: host({ serves: (input) => { asked.push(input.workspaceId); return linkedAnswer() } })
  })
  assert.ok(mounted.find({ type: 'Heading', text: 'this workspace' }))
  assert.deepEqual(asked, [LINKED], 'what it serves is asked by the focused workspace')
  assert.ok(mounted.find({ type: 'KeyValue', label: 'this workspace' }))
  const row = mounted.find({ type: 'ListItem', label: 'The served task' })
  assert.ok(row, 'the task by title')
  assert.equal(row.props['description'], 'task · in progress', 'its stage in words')
  const ref = mounted.find({ type: 'KeyValue', label: 'the task it serves' })
  assert.ok(ref)
  assert.match(JSON.stringify(ref.props['items']), new RegExp(TASK_REF))
  assert.equal(mounted.find({ type: 'ListItem', label: 'Claude' })?.props['description'], 'claude · working')
  assert.equal(mounted.find({ type: 'ListItem', label: 'codex' })?.props['description'], 'codex · done')
  assert.ok(mounted.find({ type: 'Heading', text: 'agents 2' }))

  await mounted.press({ type: 'ListItem', label: 'The served task' })
  assert.ok(mounted.find({ type: 'Heading', text: 'The served task' }), 'the press opens the detail')
  assert.deepEqual(mounted.refusals, [])
})

test('an unlinked workspace says it serves no temper task', async () => {
  mounted = await mount(panel, { host: host({ serves: () => ({ state: 'unlinked' as const }) }) })
  assert.ok(mounted.find({ type: 'Text', text: '— This workspace serves no temper task.' }))
  assert.equal(mounted.find({ type: 'KeyValue', label: 'the task it serves' }), null)
  assert.ok(mounted.find({ type: 'Heading', text: 'agents 2' }), 'its agents still show')
})

test('a link to a goal serves no task, and names what the workspace was started from', async () => {
  mounted = await mount(panel, { host: host({ serves: () => linkedAnswer('goal') }) })
  assert.ok(mounted.find({ type: 'Text', text: '— This workspace serves no temper task.' }))
  assert.ok(mounted.find({ type: 'Text', text: 'It was started from this goal:' }))
  assert.equal(mounted.find({ type: 'ListItem', label: 'The served task' })?.props['description'], 'goal · active')
})

test('no focused workspace says so, and reads nothing it serves', async () => {
  const asked: string[] = []
  mounted = await mount(panel, {
    host: host({ context: null, serves: (input) => { asked.push(input.workspaceId); return { state: 'unlinked' as const } } })
  })
  assert.ok(mounted.find({ type: 'Text', text: '— No workspace is focused.' }))
  assert.deepEqual(asked, [])
})

test('a withheld consent names itself, and no Orca read is made', async () => {
  const granted = ALL.filter((kind) => kind !== 'workspace:read' && kind !== 'agent:read')
  const h = host({ granted })
  mounted = await mount(panel, { host: h })
  assert.ok(mounted.find({ type: 'Text', text: /^This workspace needs the 'Read your projects and workspaces/ }))
  assert.deepEqual(h.callsOf('workspace.readContext'), [])
  assert.deepEqual(h.callsOf('agents.list'), [])
  assert.deepEqual(mounted.refusals, [])
})

test('without agent:read the agents line names its consent and agents.list is never called', async () => {
  const h = host({ granted: ALL.filter((kind) => kind !== 'agent:read') })
  mounted = await mount(panel, { host: h })
  assert.ok(mounted.find({ type: 'ListItem', label: 'The served task' }))
  assert.ok(mounted.find({ type: 'Text', text: "The agents line needs the 'Get notified when agent status changes' consent." }))
  assert.deepEqual(h.callsOf('agents.list'), [])
})

test('a focus change reads what the new workspace serves; a status change reads its agents', async () => {
  const asked: string[] = []
  const h = host({
    serves: (input) => {
      asked.push(input.workspaceId)
      return input.workspaceId === LINKED ? linkedAnswer() : { state: 'unlinked' as const }
    }
  })
  mounted = await mount(panel, { host: h })
  const before = h.callsOf('agents.list').length
  await mounted.emit('agent.status.changed', {
    workspaceId: 'raw', workspaceListId: LINKED, paneKey: 'p', state: 'waiting', receivedAt: Date.now()
  })
  assert.equal(h.callsOf('agents.list').length, before + 1, 'its agents are read again')
  await mounted.emit('workspace.changed', { context: context('identity:wt2:local:other') })
  assert.deepEqual(asked, [LINKED, 'identity:wt2:local:other'])
  assert.ok(mounted.find({ type: 'Text', text: '— This workspace serves no temper task.' }))
})
