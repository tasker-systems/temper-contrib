// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses. The worker
// is stood in by mockHost's request answers: what matters here is that the panel shows the
// answer — the three in-force groups, or the signed-out refusal — without inventing its own.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { ActiveGoalsOutput, InProgressTasksOutput, LatestHandoffOutput } from './protocol'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

const GOALS: ActiveGoalsOutput = {
  connected: true,
  contexts: ['@me/temper'],
  truncated: false,
  goals: [
    { id: '00000000-0000-7000-8000-0000000000a1', ref: 'goal-one-00000000-0000-7000-8000-0000000000a1', title: 'Goal one' },
    { id: '00000000-0000-7000-8000-0000000000b2', ref: 'goal-two-00000000-0000-7000-8000-0000000000b2', title: 'Goal two' }
  ]
}
const TASKS: InProgressTasksOutput = {
  connected: true,
  contexts: ['+temper-dev/contrib-workflows'],
  truncated: false,
  tasks: []
}
const HANDOFF: LatestHandoffOutput = {
  connected: true,
  contexts: ['+temper-dev/contrib-workflows'],
  truncated: false,
  handoff: null
}

test('lists the groups the worker answered', async () => {
  const host = mockHost({
    requests: {
      'temper.goals.active': () => GOALS,
      'temper.tasks.in-progress': () => TASKS,
      'temper.handoff.latest': () => HANDOFF
    }
  })
  mounted = await mount(panel, { host })
  assert.ok(mounted.find({ label: 'Goal one' }), 'Goal one is on the panel')
  assert.ok(mounted.find({ label: 'Goal two' }), 'Goal two is on the panel')
  assert.ok(mounted.find({ text: 'No tasks in progress in +temper-dev/contrib-workflows.' }), 'the empty tasks group is on the panel')
  assert.ok(mounted.find({ text: 'No session notes in +temper-dev/contrib-workflows.' }), 'the empty handoff group is on the panel')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('shows the refusal text when the worker reports temper is not connected', async () => {
function refuse(contexts: string[]): {
  connected: false
  contexts: string[]
  message: string
} {
  return {
    connected: false,
    contexts,
    message: 'temper is not connected — sign in with the temper CLI'
  }
}
  const host = mockHost({
    requests: {
      'temper.goals.active': () => refuse(['@me/temper']),
      'temper.tasks.in-progress': () => refuse(['@me/temper']),
      'temper.handoff.latest': () => refuse(['@me/temper'])
    }
  })
  mounted = await mount(panel, { host })
  assert.ok(mounted.find({ label: 'temper is not connected' }), 'the refusal is on the panel')
  const state = mounted.find({ type: 'EmptyState' })
  assert.match(String(state?.props.description), /sign in with the temper CLI/)
  assert.equal(mounted.find({ label: 'Goal one' }), null)
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})
