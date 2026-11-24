// A task's work in Orca on its detail, and temper's claim in the launch sheet (decision ruling
// 26), against mockHost request answers. Pinned here: nothing is recorded without the press, and
// one press asks once — a second press while it is out asks nothing; Reopen from a record is
// labelled with the run's date and offered only for this host's runs; a task done elsewhere
// keeps temper's done stage whatever its records say, and still offers Reopen; a task claimed
// elsewhere shows temper's claim in the sheet and stays launchable.
import { assert, afterEach, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { RecordDetailOutput } from './protocol'
import type { RecordWorkInput, ReopenRecordInput, TaskClaimOutput, WorkRecordsOutput } from './work-protocol'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

const TASK_ID = '00000000-0000-7000-8000-0000000000f3'
const GRANTED = ['settings:own', 'workspace:read', 'workspace:create', 'agent:launch', 'agent:read', 'storage:own']

function taskDetail(stage: string): RecordDetailOutput {
  return {
    state: 'ok',
    detail: {
      id: TASK_ID,
      ref: `the-work-task-${TASK_ID}`,
      title: 'The work task',
      docType: 'task',
      stage,
      status: null,
      contextRef: '+team/c',
      properties: [{ label: 'temper-stage', value: stage }]
    }
  }
}

const HERE = {
  artifactId: '00000000-0000-7000-8000-0000000000c2',
  agent: 'claude',
  workspaceName: 'contrib · pt/here',
  branch: 'pt/here',
  sessionId: 's-here',
  startedAt: '2026-11-22T10:00:00Z',
  finishedAt: '2026-11-22T11:30:00Z',
  outcome: 'success' as const,
  sessionNote: null,
  here: true
}
const ELSEWHERE = { ...HERE, artifactId: '00000000-0000-7000-8000-0000000000c1', workspaceName: 'laptop · pt/away', sessionId: 's-away', here: false }
const RECORDABLE = { workspaceId: 'ws-new', workspaceName: 'contrib · pt/new', agent: 'codex', finishedAt: '2026-11-23T12:00:00.000Z', outcome: 'unreported' as const }

interface Asked {
  records: RecordWorkInput[]
  reopens: ReopenRecordInput[]
  launches: number
}

function host(options: { stage: string; work: () => WorkRecordsOutput; claim?: TaskClaimOutput; record?: () => Promise<unknown> }) {
  const asked: Asked = { records: [], reopens: [], launches: 0 }
  const answer = mockHost({
    capabilities: GRANTED,
    requests: {
      'temper.capabilities': () => ({ granted: GRANTED }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => ({ state: 'ok', sessionCount: 0, handoff: null }),
      'temper.home.way-in': () => ({ state: 'ok', id: 'goals', label: 'goals', scope: 'goals of yours', rows: [], total: 0, bound: 8 }),
      'temper.home.places': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.resource.detail': () => taskDetail(options.stage),
      'temper.launch.links': () => ({ state: 'ok', links: [] }),
      'temper.launch.projects': () => ({ state: 'ok', projects: [{ id: 'proj-one', name: 'contrib', path: '/p', hostId: 'local' }] }),
      'temper.launch.agents': () => ({ state: 'ok', agents: [{ id: 'claude', name: 'Claude', isDefault: true }] }),
      'temper.launch.task-handoff': () => ({ state: 'ok', handoff: null }),
      'temper.launch.go': () => {
        asked.launches += 1
        return { state: 'launched', workspaceId: 'ws-x', terminalId: null, linkError: null }
      },
      'temper.work.records': () => options.work(),
      'temper.work.record': async (input: RecordWorkInput) => {
        asked.records.push(input)
        await options.record?.()
        return { state: 'recorded', artifactId: '00000000-0000-7000-8000-0000000000c9' }
      },
      'temper.work.reopen': (input: ReopenRecordInput) => {
        asked.reopens.push(input)
        return { state: 'reopened', terminalId: 't-back', started: true }
      },
      'temper.task.claim': () => options.claim ?? { state: 'ok', claim: null }
    }
  })
  return { host: answer, asked }
}

const seeded = { persisted: { plugin: { 'detail-stack': [{ id: TASK_ID, ref: '', title: '', docType: 'task' }] } } }

test('a finished run is offered to record, and nothing is recorded without the press', async () => {
  const { host: served, asked } = host({ stage: 'in-progress', work: () => ({ state: 'ok', records: [], recordable: [RECORDABLE] }) })
  mounted = await mount(panel, { host: served, ...seeded })
  await mounted.settled()
  assert.ok(mounted.find({ type: 'Button', text: `Record this work — ${RECORDABLE.workspaceName}` }))
  assert.ok(mounted.find({ text: '— No Orca runs recorded on this task.' }))
  assert.deepEqual(asked.records, [], 'the detail opening records nothing')
  assert.deepEqual(mounted.errors, [])
})

test('one press records once; a second press while it is out asks nothing', async () => {
  let recorded = false
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { host: served, asked } = host({
    stage: 'in-progress',
    work: () => (recorded ? { state: 'ok', records: [{ ...HERE, workspaceName: RECORDABLE.workspaceName }], recordable: [] } : { state: 'ok', records: [], recordable: [RECORDABLE] }),
    record: async () => {
      await gate
      recorded = true
    }
  })
  mounted = await mount(panel, { host: served, ...seeded })
  await mounted.settled()
  const press = mounted.find({ type: 'Button', text: `Record this work — ${RECORDABLE.workspaceName}` })!
  void mounted.press(press)
  void mounted.press(press)
  release()
  await mounted.settled()
  assert.equal(asked.records.length, 1, 'one request for the run')
  assert.equal(mounted.find({ type: 'Button', text: /^Record this work/ }), null, 'the recorded run is not offered again')
  assert.ok(mounted.find({ type: 'Button', text: /^Reopen agent — run of / }), 'the record reads back with its Reopen')
  assert.deepEqual(mounted.errors, [])
})

test('Reopen from a record is labelled with the run\'s date, and only this host\'s runs offer it', async () => {
  const { host: served, asked } = host({ stage: 'in-progress', work: () => ({ state: 'ok', records: [HERE, ELSEWHERE], recordable: [] }) })
  mounted = await mount(panel, { host: served, ...seeded })
  await mounted.settled()
  const reopens = mounted.findAll({ type: 'Button', text: /^Reopen agent — run of / })
  assert.deepEqual(reopens.map((button) => button.text), ['Reopen agent — run of 22 Nov 2026'])
  assert.ok(mounted.find({ text: 'Run on another Orca host — its session reopens only there.' }))
  assert.ok(mounted.find({ text: '22 Nov 2026, 10:00–11:30 UTC' }), 'the row says when the run ran')
  await mounted.press(reopens[0]!)
  await mounted.settled()
  assert.deepEqual(asked.reopens, [{ itemId: TASK_ID, artifactId: HERE.artifactId }])
  assert.ok(mounted.find({ type: 'Callout', label: `The agent session was reopened in ${HERE.workspaceName}.` }))
  assert.equal(asked.launches, 0)
  assert.deepEqual(mounted.errors, [])
})

test('a task done elsewhere keeps its done stage whatever its records say, and still offers Reopen', async () => {
  const { host: served } = host({
    stage: 'done',
    work: () => ({ state: 'ok', records: [{ ...HERE, outcome: 'interruption' }], recordable: [RECORDABLE] })
  })
  mounted = await mount(panel, { host: served, ...seeded })
  await mounted.settled()
  assert.ok(mounted.find({ type: 'Badge', text: 'done' }), 'the header reads temper\'s stage')
  assert.equal(mounted.find({ type: 'Badge', text: 'in progress' }), null, 'no record or link makes it look live')
  assert.equal(mounted.find({ type: 'Button', text: /^(Start agent|Resume task)$/ }), null, 'a done task offers no launch')
  assert.ok(mounted.find({ type: 'Button', text: /^Reopen agent — run of / }), 'Reopen is offered whatever the stage')
  assert.deepEqual(mounted.errors, [])
})

test('a task claimed elsewhere shows temper\'s claim in the sheet and stays launchable', async () => {
  const { host: served, asked } = host({
    stage: 'in-progress',
    work: () => ({ state: 'ok', records: [], recordable: [] }),
    claim: {
      state: 'ok',
      claim: { claimId: 'c0ffee00-0000-4000-8000-000000000001', claimedAt: '2026-11-23T09:00:00Z', heartbeatAt: '2026-11-23T09:30:00Z' }
    }
  })
  mounted = await mount(panel, { host: served, ...seeded })
  await mounted.settled()
  await mounted.press(mounted.find({ type: 'Button', text: 'Resume task' })!)
  await mounted.settled()
  assert.ok(mounted.find({ type: 'Callout', label: 'temper shows this task claimed' }))
  assert.ok(mounted.find({ text: 'Claim c0ffee00 is held — another agent may be working this task.' }))
  assert.equal(mounted.findAll({ type: 'RelativeTime' }).length >= 2, true, 'claimed and heartbeat, each as a time')
  await mounted.select({ label: 'Project' }, 'proj-one')
  const confirms = mounted.findAll({ type: 'Button', text: 'Resume task' })
  const confirm = confirms[confirms.length - 1]!
  assert.notEqual(confirm.props.disabled, true, 'the claim never disables the launch')
  await mounted.press(confirm)
  await mounted.settled()
  assert.equal(asked.launches, 1)
  assert.deepEqual(mounted.errors, [])
})

test('an unclaimed task says so in the sheet', async () => {
  const { host: served } = host({ stage: 'backlog', work: () => ({ state: 'ok', records: [], recordable: [] }) })
  mounted = await mount(panel, { host: served, ...seeded })
  await mounted.settled()
  await mounted.press(mounted.find({ type: 'Button', text: 'Start agent' })!)
  await mounted.settled()
  assert.ok(mounted.find({ text: 'temper shows no claim on this task.' }))
  assert.deepEqual(mounted.errors, [])
})
