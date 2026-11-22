// Home's ways in by status (ruling 24): Tasks by backlog, in progress or done, Goals by active or
// done. Each toggle asks the way in again under its own status, the count and omission sentence
// follow the status shown, the pick is held across the panel's runs, and the other regions are
// never asked again for it. The request answers are fixture data, typed here so the file stands
// on its own; the worker tests pin the filters each status sends with `owner=@me`.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

const SCOPES: Record<string, Record<string, string>> = {
  tasks: {
    backlog: 'backlog tasks of yours',
    'in-progress': 'tasks in progress of yours',
    done: 'done tasks of yours'
  },
  goals: { active: 'active goals of yours', completed: 'completed goals of yours' }
}
const DEFAULTS: Record<string, string> = { tasks: 'in-progress', goals: 'active' }
const TOTALS: Record<string, number> = {
  'tasks/backlog': 23,
  'tasks/in-progress': 2,
  'tasks/done': 41,
  'goals/active': 3,
  'goals/completed': 12
}

interface WayAsk {
  id: string
  bound: number
  status?: string
}

function served(asks: WayAsk[], counts: Record<string, number> = {}) {
  const count = (name: string) => () => {
    counts[name] = (counts[name] ?? 0) + 1
  }
  return mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: ['settings:own'] }),
      'temper.home.resume': () => {
        count('resume')()
        return {
          state: 'ok',
          resume: {
            resource: {
              id: '00000000-0000-7000-8000-0000000000f1',
              ref: 'r-00000000-0000-7000-8000-0000000000f1',
              title: 'The thing I changed',
              docType: 'decision',
              contextRef: null,
              updated: '2026-11-20T01:00:00Z',
              stage: null
            },
            changedAt: '2026-11-20T02:00:00Z'
          }
        }
      },
      'temper.home.handoff': () => {
        count('handoff')()
        return { state: 'ok', sessionCount: 0, handoff: null }
      },
      'temper.home.places': () => {
        count('places')()
        return { state: 'ok', rows: [], total: 0 }
      },
      'temper.home.recent': () => {
        count('recent')()
        return { state: 'ok', rows: [], total: 0 }
      },
      'temper.home.way-in': (input: WayAsk) => {
        asks.push(input)
        const status = input.status ?? DEFAULTS[input.id] ?? null
        const scope = status === null ? 'sessions of yours' : (SCOPES[input.id]?.[status] ?? input.id)
        const total = TOTALS[`${input.id}/${status}`] ?? 0
        const docType = input.id === 'tasks' ? 'task' : input.id === 'goals' ? 'goal' : 'session'
        const rows = Array.from({ length: Math.min(total, input.bound) }, (_, index) => {
          const n = String(index).padStart(2, '0')
          const id = `00000000-0000-7000-8000-00000000${input.id.slice(0, 1) === 't' ? '1' : '2'}${status === 'done' || status === 'completed' ? '9' : '0'}${n}`
          return {
            id,
            ref: `row-${id}`,
            title: `${input.id} ${status} ${index + 1}`,
            docType,
            contextRef: null,
            updated: '2026-11-20T01:00:00Z',
            stage: status
          }
        })
        return {
          state: 'ok',
          id: input.id,
          label: input.id,
          scope,
          status,
          rows,
          total,
          bound: input.bound
        }
      }
    }
  })
}

const lastAsk = (asks: WayAsk[], id: string) => [...asks].reverse().find((ask) => ask.id === id)

test('the toggles default to in progress and active, so Home opens as before', async () => {
  const asks: WayAsk[] = []
  mounted = await mount(panel, { host: served(asks) })

  assert.equal(mounted.valueOf({ type: 'Tabs', label: 'tasks by stage' }), 'in-progress')
  assert.equal(mounted.valueOf({ type: 'Tabs', label: 'goals by status' }), 'active')
  assert.equal(lastAsk(asks, 'tasks')?.status, 'in-progress', 'tasks are asked in progress')
  assert.equal(lastAsk(asks, 'goals')?.status, 'active', 'goals are asked active')
  assert.equal(lastAsk(asks, 'sessions')?.status, undefined, 'sessions take no status')
  assert.ok(mounted.find({ type: 'Heading', text: 'tasks 2' }))
  assert.ok(mounted.find({ text: 'All 2 tasks in progress of yours.' }))
  assert.ok(mounted.find({ type: 'Heading', text: 'goals 3' }))
  assert.ok(mounted.find({ text: 'All 3 active goals of yours.' }))
  assert.equal(mounted.find({ type: 'Tabs', label: 'sessions by status' }), null)
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.warnings, [])
})

test('each toggle asks under its status; the count and omission sentence follow it', async () => {
  const asks: WayAsk[] = []
  mounted = await mount(panel, { host: served(asks) })

  await mounted.select({ type: 'Tabs', label: 'tasks by stage' }, 'backlog')
  assert.deepEqual(lastAsk(asks, 'tasks'), { id: 'tasks', bound: 8, status: 'backlog' })
  assert.ok(mounted.find({ type: 'Heading', text: 'tasks 23' }), 'the badge counts the backlog')
  assert.ok(mounted.find({ text: '8 of 23 backlog tasks of yours; 15 not shown.' }))
  assert.ok(mounted.find({ label: 'tasks backlog 1' }), 'the backlog rows show')
  assert.equal(mounted.find({ label: 'tasks in-progress 1' }), null, 'the in-progress rows are gone')

  await mounted.select({ type: 'Tabs', label: 'tasks by stage' }, 'done')
  assert.deepEqual(lastAsk(asks, 'tasks'), { id: 'tasks', bound: 8, status: 'done' })
  assert.ok(mounted.find({ type: 'Heading', text: 'tasks 41' }))
  assert.ok(mounted.find({ text: '8 of 41 done tasks of yours; 33 not shown.' }))

  await mounted.select({ type: 'Tabs', label: 'goals by status' }, 'completed')
  assert.deepEqual(lastAsk(asks, 'goals'), { id: 'goals', bound: 8, status: 'completed' })
  assert.ok(mounted.find({ type: 'Heading', text: 'goals 12' }))
  assert.ok(mounted.find({ text: '8 of 12 completed goals of yours; 4 not shown.' }))
  assert.ok(mounted.find({ type: 'Heading', text: 'tasks 41' }), 'the goals toggle leaves tasks as they were')
  assert.deepEqual(mounted.errors, [])
})

test('Show more grows the status shown, and a new status starts over at the bound', async () => {
  const asks: WayAsk[] = []
  mounted = await mount(panel, { host: served(asks) })

  await mounted.select({ type: 'Tabs', label: 'tasks by stage' }, 'backlog')
  await mounted.press({ text: 'Show more' })
  assert.deepEqual(lastAsk(asks, 'tasks'), { id: 'tasks', bound: 16, status: 'backlog' })
  assert.ok(mounted.find({ text: '16 of 23 backlog tasks of yours; 7 not shown.' }))

  await mounted.select({ type: 'Tabs', label: 'tasks by stage' }, 'done')
  assert.deepEqual(lastAsk(asks, 'tasks'), { id: 'tasks', bound: 8, status: 'done' }, 'growth is per status')
  assert.ok(mounted.find({ text: '8 of 41 done tasks of yours; 33 not shown.' }))
  assert.deepEqual(mounted.errors, [])
})

test('the pick is held across the panel\'s runs and read back on the next', async () => {
  const asks: WayAsk[] = []
  mounted = await mount(panel, { host: served(asks) })
  await mounted.select({ type: 'Tabs', label: 'tasks by stage' }, 'backlog')
  await mounted.select({ type: 'Tabs', label: 'goals by status' }, 'completed')
  const held = mounted.persisted.plugin['way-in-status']
  assert.deepEqual(held, { tasks: 'backlog', goals: 'completed' })
  mounted.unmount()

  const again: WayAsk[] = []
  mounted = await mount(panel, { host: served(again), persisted: { plugin: { 'way-in-status': held } } })
  assert.equal(mounted.valueOf({ type: 'Tabs', label: 'tasks by stage' }), 'backlog')
  assert.equal(mounted.valueOf({ type: 'Tabs', label: 'goals by status' }), 'completed')
  assert.equal(lastAsk(again, 'tasks')?.status, 'backlog', 'the next run asks the held status first')
  assert.equal(lastAsk(again, 'goals')?.status, 'completed')
  assert.ok(mounted.find({ type: 'Heading', text: 'tasks 23' }))
  assert.deepEqual(mounted.errors, [])
})

test('a held status the way no longer offers falls back to its default', async () => {
  const asks: WayAsk[] = []
  mounted = await mount(panel, {
    host: served(asks),
    persisted: { plugin: { 'way-in-status': { tasks: 'someday' } } }
  })
  assert.equal(lastAsk(asks, 'tasks')?.status, 'in-progress')
  assert.equal(mounted.valueOf({ type: 'Tabs', label: 'tasks by stage' }), 'in-progress')
  assert.deepEqual(mounted.errors, [])
})

test('a goals toggle held as done from before the fix falls back to active, never asking temper for done', async () => {
  const asks: WayAsk[] = []
  mounted = await mount(panel, {
    host: served(asks),
    persisted: { plugin: { 'way-in-status': { goals: 'done' } } }
  })
  assert.equal(lastAsk(asks, 'goals')?.status, 'active')
  assert.equal(mounted.valueOf({ type: 'Tabs', label: 'goals by status' }), 'active')
  assert.ok(!asks.some((ask) => ask.id === 'goals' && ask.status === 'done'))
  assert.deepEqual(mounted.errors, [])
})

test('a toggle asks again for its own way only; the other regions are untouched', async () => {
  const asks: WayAsk[] = []
  const counts: Record<string, number> = {}
  mounted = await mount(panel, { host: served(asks, counts) })
  const before = { ...counts }
  const sessionAsks = asks.filter((ask) => ask.id === 'sessions').length

  await mounted.select({ type: 'Tabs', label: 'tasks by stage' }, 'done')
  await mounted.select({ type: 'Tabs', label: 'goals by status' }, 'completed')

  assert.deepEqual(counts, before, 'resume, handoff, places and recently updated are not asked again')
  assert.equal(asks.filter((ask) => ask.id === 'sessions').length, sessionAsks, 'sessions are not asked again')
  assert.ok(mounted.find({ label: 'The thing I changed' }), 'resume still stands')
  assert.ok(mounted.find({ text: '— No sessions of yours.' }), 'sessions still stand')
  assert.ok(mounted.find({ type: 'Heading', text: 'recently updated 0' }), 'recently updated still stands')
  assert.ok(mounted.find({ type: 'Heading', text: 'places 0' }), 'places still stand')
  assert.equal(mounted.find({ type: 'Tabs', label: 'temper view' }) !== null, true)
  assert.equal(mounted.valueOf({ type: 'Tabs', label: 'temper view' }), 'home', 'the frame stays on Home')
  assert.deepEqual(mounted.errors, [])
})

test('a status whose read fails keeps the toggle and names what failed', async () => {
  const host = mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: ['settings:own'] }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => ({ state: 'ok', sessionCount: 0, handoff: null }),
      'temper.home.places': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.way-in': (input: WayAsk) =>
        input.status === 'done'
          ? { state: 'failed', message: 'temper answered 503 on the done tasks of yours read' }
          : { state: 'ok', id: input.id, label: input.id, scope: 'x', status: input.status ?? null, rows: [], total: 0, bound: input.bound }
    }
  })
  mounted = await mount(panel, { host })
  await mounted.select({ type: 'Tabs', label: 'tasks by stage' }, 'done')
  assert.ok(mounted.find({ type: 'Callout', label: 'tasks unavailable — nothing here was read.' }))
  assert.equal(mounted.valueOf({ type: 'Tabs', label: 'tasks by stage' }), 'done', 'the toggle stays to pick again')
  await mounted.select({ type: 'Tabs', label: 'tasks by stage' }, 'backlog')
  assert.equal(mounted.find({ type: 'Callout', label: 'tasks unavailable — nothing here was read.' }), null)
  assert.ok(mounted.find({ type: 'Heading', text: 'tasks 0' }))
  assert.deepEqual(mounted.errors, [])
})
