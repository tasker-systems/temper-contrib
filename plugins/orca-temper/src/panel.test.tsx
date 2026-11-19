// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses. The worker
// is stood in by mockHost's request answers: what matters here is that the panel shows the
// answer — goals, or the signed-out refusal — without inventing its own.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { ActiveGoalsOutput } from './protocol'

const GOALS: ActiveGoalsOutput = {
  connected: true,
  contextRef: '@me/temper',
  truncated: false,
  goals: [
    { id: '00000000-0000-7000-8000-0000000000a1', ref: 'goal-one-00000000-0000-7000-8000-0000000000a1', title: 'Goal one' },
    { id: '00000000-0000-7000-8000-0000000000b2', ref: 'goal-two-00000000-0000-7000-8000-0000000000b2', title: 'Goal two' }
  ]
}

test('lists the goals the worker answered', async () => {
  const host = mockHost({ requests: { 'temper.goals.active': () => GOALS } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'Goal one' }), 'Goal one is on the panel')
  assert.ok(view.find({ label: 'Goal two' }), 'Goal two is on the panel')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows the refusal text when the worker reports temper is not connected', async () => {
  const host = mockHost({
    requests: {
      'temper.goals.active': () => ({
        connected: false,
        contextRef: '@me/temper',
        message: 'temper is not connected — sign in with the temper CLI'
      })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'temper is not connected' }), 'the refusal is on the panel')
  const state = view.find({ type: 'EmptyState' })
  assert.match(String(state?.props.description), /sign in with the temper CLI/)
  assert.equal(view.find({ label: 'Goal one' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
