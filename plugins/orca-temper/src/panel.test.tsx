// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses. The worker
// is stood in by mockHost's request answers: what matters here is that the panel shows the
// answer — Home's regions, or the signed-out refusal — without inventing its own.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

function item(suffix: string, title: string, docType: string, contextRef: string | null = '+temper-dev/contrib') {
  return {
    id: `00000000-0000-7000-8000-0000000000${suffix}`,
    ref: `row-00000000-0000-7000-8000-0000000000${suffix}`,
    title,
    docType,
    contextRef,
    updated: '2026-11-20T01:00:00Z',
    stage: null
  }
}

const NOT_CONNECTED = {
  state: 'not-connected' as const,
  message: 'temper is not connected — sign in with the temper CLI'
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
      'temper.capabilities': () => ({ granted: ['settings:own'] }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => ({ state: 'ok', sessionCount: 0, handoff: null }),
      'temper.home.way-in': (input: { id: string; bound: number }) => ({
        state: 'ok' as const,
        id: input.id,
        label: WAY_LABELS[input.id] ?? input.id,
        scope: WAY_SCOPES[input.id] ?? input.id,
        rows: input.id === 'goals' ? [item('a1', 'Goal one', 'goal')] : [],
        total: input.id === 'goals' ? 1 : 0,
        bound: 8
      }),
      'temper.home.places': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 })
    }
  })
}

test('lists the regions the worker answered, each with its own empty words', async () => {
  mounted = await mount(panel, { host: servedHost() })
  assert.ok(mounted.find({ label: 'Goal one' }), 'Goal one is on the panel')
  assert.ok(mounted.find({ text: 'All 1 active goals of yours.' }), 'the goals omission sentence is on the panel')
  assert.ok(mounted.find({ text: '— No tasks in progress of yours.' }), 'the empty tasks way-in is on the panel')
  assert.ok(mounted.find({ text: '— No sessions of yours.' }), 'the empty sessions way-in is on the panel')
  assert.ok(mounted.find({ text: '— No places you changed something in.' }), 'the empty places region is on the panel')
  assert.ok(mounted.find({ text: '— No resources you can read.' }), 'the empty recently-updated region is on the panel')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('shows the refusal text when the worker reports temper is not connected', async () => {
  const host = mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: ['settings:own'] }),
      'temper.home.resume': () => NOT_CONNECTED,
      'temper.home.handoff': () => NOT_CONNECTED,
      'temper.home.way-in': () => NOT_CONNECTED,
      'temper.home.places': () => NOT_CONNECTED,
      'temper.home.recent': () => NOT_CONNECTED
    }
  })
  mounted = await mount(panel, { host })
  assert.ok(mounted.find({ label: 'temper is not connected' }), 'the refusal is on the panel')
  const state = mounted.find({ type: 'EmptyState' })
  assert.match(String(state?.props.description), /sign in with the temper CLI/)
  assert.equal(mounted.find({ label: 'Goal one' }), null)
  assert.equal(mounted.find({ type: 'Heading', text: 'goals 0' }), null, 'no region claims a count over a refusal')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('a failed region names what failed beside the regions that answered', async () => {
  const host = mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: ['settings:own'] }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => ({ state: 'failed', message: 'temper refused the handoff body read: boom' }),
      'temper.home.way-in': (input: { id: string; bound: number }) => ({
        state: 'ok' as const,
        id: input.id,
        label: WAY_LABELS[input.id] ?? input.id,
        scope: 'scopes',
        rows: [],
        total: 0,
        bound: 8
      }),
      'temper.home.places': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 })
    }
  })
  mounted = await mount(panel, { host })
  assert.ok(
    mounted.find({ text: '⚠ latest handoff unavailable — nothing here was read.' }),
    'the failed region names what failed, never showing as empty'
  )
  assert.equal(mounted.find({ text: '— No sessions of yours.' }), null, 'a failure never shows as empty')
  assert.ok(mounted.find({ type: 'Heading', text: 'goals 0' }), 'the regions that answered still render')
  assert.equal(mounted.find({ type: 'EmptyState' }), null, 'one failure is not the signed-out refusal')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})
