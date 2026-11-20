// The rail's frame: Home / Explore / Search sub-tabs, the in-panel detail stack with Back,
// the doc-type words standing where icons would, and the signed-out refusal holding on every
// tab. The worker's answers are fixture data; the capabilities answer rides along as the
// worker sends it.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

const GRANTED = ['settings:own', 'workspace:read', 'workspace:create']

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

function servedHost(): ReturnType<typeof mockHost> {
  return mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: GRANTED }),
      'temper.goals.active': () => ({
        connected: true,
        contexts: ['@me/temper'],
        truncated: false,
        goals: [
          { id: '00000000-0000-7000-8000-0000000000a1', ref: 'goal-one-00000000-0000-7000-8000-0000000000a1', title: 'Goal one' }
        ]
      }),
      'temper.tasks.in-progress': () => ({ connected: true, contexts: ['+temper-dev/contrib-workflows'], truncated: false, tasks: [] }),
      'temper.handoff.latest': () => ({ connected: true, contexts: ['+temper-dev/contrib-workflows'], truncated: false, handoff: null })
    }
  })
}

test('home holds first; explore and search say what arrives later', async () => {
  mounted = await mount(panel, { host: servedHost() })
  assert.ok(mounted.find({ text: 'Active goals (1)' }), 'home is the tab that holds first')
  assert.equal(
    mounted.find({ text: 'Explore arrives with a later iteration — teams, then their contexts.' }),
    null,
    'the explore placeholder does not show while home holds'
  )

  await mounted.select({ type: 'Tabs' }, 'explore')
  assert.ok(
    mounted.find({ text: 'Explore arrives with a later iteration — teams, then their contexts.' }),
    'explore names its placeholder'
  )
  assert.equal(mounted.find({ text: 'Active goals (1)' }), null, 'the home body does not show under explore')
  assert.deepEqual(mounted.warnings, [])

  await mounted.select({ type: 'Tabs' }, 'search')
  assert.ok(
    mounted.find({ text: 'Search arrives with a later iteration — exact and by-meaning matching.' }),
    'search names its placeholder'
  )
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('pressing an item pushes a detail view; Back returns to the tab', async () => {
  mounted = await mount(panel, { host: servedHost() })

  await mounted.press({ label: 'Goal one' })
  assert.ok(mounted.find({ text: 'Goal one' }), 'the detail carries the item title')
  assert.ok(mounted.find({ text: 'goal' }), 'the detail leads with the doc-type word')
  assert.ok(
    mounted.find({ text: 'goal-one-00000000-0000-7000-8000-0000000000a1' }),
    'the detail carries the ref'
  )
  assert.equal(mounted.find({ type: 'Tabs' }), null, 'the detail holds the panel; no tabs beside it')

  await mounted.press({ text: 'Back' })
  assert.ok(mounted.find({ text: 'Active goals (1)' }), 'back returns to the tab that held')

  // Pushing twice pops once only: the stack holds the pushed views.
  await mounted.press({ label: 'Goal one' })
  await mounted.press({ text: 'Back' })
  assert.ok(mounted.find({ text: 'Active goals (1)' }), 'a single pop lands back on the frame')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('rows carry the doc-type word, not icons', async () => {
  mounted = await mount(panel, { host: servedHost() })
  const row = mounted.find({ type: 'ListItem' })
  assert.notEqual(row, null)
  assert.equal(row?.props.description, 'goal', 'the doc-type word leads the row')
  assert.equal(row?.props.icon, undefined, 'no icon stands for the doc type')
  assert.ok(row?.props.onPress, 'the row opens its detail')
  assert.deepEqual(mounted.warnings, [])
})

test('empty lists carry the — word', async () => {
  mounted = await mount(panel, { host: servedHost() })
  assert.ok(mounted.find({ text: '— No tasks in progress in +temper-dev/contrib-workflows.' }))
  assert.ok(mounted.find({ text: '— No session notes in +temper-dev/contrib-workflows.' }))
})

test('the signed-out refusal holds on every tab', async () => {
  const host = mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: GRANTED }),
      'temper.goals.active': () => refuse(['@me/temper']),
      'temper.tasks.in-progress': () => refuse(['@me/temper']),
      'temper.handoff.latest': () => refuse(['@me/temper'])
    }
  })
  mounted = await mount(panel, { host })
  assert.ok(
    mounted.find({ label: 'temper is not connected' }),
    'the refusal stands on home'
  )
  await mounted.select({ type: 'Tabs' }, 'explore')
  assert.ok(mounted.find({ label: 'temper is not connected' }), 'the refusal holds on explore')
  assert.equal(
    mounted.find({ text: 'Explore arrives with a later iteration — teams, then their contexts.' }),
    null,
    'no placeholder claims a region temper was never read for'
  )
  await mounted.select({ type: 'Tabs' }, 'search')
  assert.ok(mounted.find({ label: 'temper is not connected' }), 'the refusal holds on search')
  await mounted.select({ type: 'Tabs' }, 'home')
  assert.ok(mounted.find({ label: 'temper is not connected' }))
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})
