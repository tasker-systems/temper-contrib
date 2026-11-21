// The rail's frame: Home / Explore / Search sub-tabs, the in-panel detail stack with Back,
// the doc-type words standing where icons would, and the signed-out refusal holding on every
// tab. The worker's answers are fixture data; the capabilities answer rides along as the
// worker sends it.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

const GRANTED = ['settings:own', 'workspace:read', 'workspace:create']

const NOT_CONNECTED = {
  state: 'not-connected' as const,
  message: 'temper is not connected — sign in with the temper CLI'
}

const GOAL_ONE = {
  id: '00000000-0000-7000-8000-0000000000a1',
  ref: 'goal-one-00000000-0000-7000-8000-0000000000a1',
  title: 'Goal one',
  docType: 'goal',
  contextRef: '+temper-dev/contrib',
  updated: '2026-11-20T01:00:00Z',
  stage: null
}

const WAY_LABELS: Record<string, string> = { goals: 'goals', tasks: 'in progress', sessions: 'sessions' }
const WAY_SCOPES: Record<string, string> = {
  goals: 'active goals of yours',
  tasks: 'tasks in progress of yours',
  sessions: 'sessions of yours'
}

function servedHost(): ReturnType<typeof mockHost> {
  return mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: GRANTED }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => ({ state: 'ok', sessionCount: 0, handoff: null }),
      'temper.home.way-in': (input: { id: string; bound: number }) => ({
        state: 'ok' as const,
        id: input.id,
        label: WAY_LABELS[input.id] ?? input.id,
        scope: WAY_SCOPES[input.id] ?? input.id,
        rows: input.id === 'goals' ? [GOAL_ONE] : [],
        total: input.id === 'goals' ? 1 : 0,
        bound: 8
      }),
      'temper.home.places': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 })
    }
  })
}

test('home holds first; explore and search say what arrives later', async () => {
  mounted = await mount(panel, { host: servedHost() })
  assert.ok(mounted.find({ type: 'Heading', text: 'goals 1' }), 'home is the tab that holds first')
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
  assert.equal(mounted.find({ type: 'Heading', text: 'goals 1' }), null, 'the home body does not show under explore')
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
  assert.equal(
    mounted.find({ text: /goal-one-00000000-0000-7000-8000-0000000000a1/ }),
    null,
    'the ref does not wrap over the header — it lives in the meta'
  )
  assert.equal(mounted.find({ type: 'Tabs' }), null, 'the detail holds the panel; no tabs beside it')

  await mounted.press({ text: 'Back' })
  assert.ok(mounted.find({ type: 'Heading', text: 'goals 1' }), 'back returns to the tab that held')

  // Pushing twice pops once only: the stack holds the pushed views.
  await mounted.press({ label: 'Goal one' })
  await mounted.press({ text: 'Back' })
  assert.ok(mounted.find({ type: 'Heading', text: 'goals 1' }), 'a single pop lands back on the frame')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('rows carry the doc-type word beside their doc-type icon', async () => {
  mounted = await mount(panel, { host: servedHost() })
  const row = mounted.find({ type: 'ListItem' })
  assert.notEqual(row, null)
  assert.equal(row?.props.description, 'goal', 'the doc-type word leads the row')
  assert.equal(row?.props.icon, 'flag', 'the icon sits beside the word, never instead of it')
  assert.ok(row?.props.onPress, 'the row opens its detail')
  assert.deepEqual(mounted.warnings, [])
})

test('the signed-out refusal holds on every tab', async () => {
  const host = mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: GRANTED }),
      'temper.home.resume': () => NOT_CONNECTED,
      'temper.home.handoff': () => NOT_CONNECTED,
      'temper.home.way-in': () => NOT_CONNECTED,
      'temper.home.places': () => NOT_CONNECTED,
      'temper.home.recent': () => NOT_CONNECTED
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
