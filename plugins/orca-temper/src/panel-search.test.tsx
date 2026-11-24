// Search (build item 9). Against mockHost request answers: the Search sub-tab asks nothing
// until words are submitted; the answer stands in two groups that never merge — exact and by
// meaning — each saying in temper-design's sentences whether more matched; a degraded meaning
// arm is a warning callout, never an empty list; a pressed result opens its record's detail; a
// context view's search asks the same read scoped by the context's id; and no request carries
// `owner` (R2). The request answers are fixture data, typed here, so this file stands alone.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

const WORKFLOWS_ID = '11111111-1111-7111-8111-111111111111'

function summary(suffix: string, title: string, docType: string, stage: string | null = null) {
  return {
    id: `00000000-0000-7000-8000-0000000000${suffix}`,
    ref: `row-00000000-0000-7000-8000-0000000000${suffix}`,
    title,
    docType,
    contextRef: '+alpha/workflows',
    updated: '2026-11-20T01:00:00Z',
    stage
  }
}

const BOTH = summary('b1', 'The side rail design', 'research')

type Asked = { query: string; contextId?: string }

function okAnswer(input: Asked, extra: { exact?: object; wide?: object } = {}) {
  return {
    state: 'ok' as const,
    query: input.query,
    contextId: input.contextId ?? null,
    exact: {
      rows: [BOTH, summary('b2', 'A side rail task', 'task', 'in-progress')],
      reason: 'ok' as const,
      truncated: true,
      ...extra.exact
    },
    wide: {
      rows: [summary('b3', 'A panel beside the editor', 'concept'), BOTH],
      reason: 'ok' as const,
      truncated: true,
      degraded: false,
      draw: { kind: 'nearest' as const, chunks: 100 },
      ...extra.wide
    }
  }
}

function servedHost(options: { asked?: Asked[]; answer?: (input: Asked) => unknown } = {}) {
  return mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: ['settings:own'] }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => ({ state: 'ok', sessionCount: 0, handoff: null }),
      'temper.home.way-in': (input: { id: string; bound: number }) => ({
        state: 'ok' as const,
        id: input.id,
        label: input.id,
        scope: input.id,
        rows: [],
        total: 0,
        bound: input.bound
      }),
      'temper.home.places': () => ({
        state: 'ok',
        rows: [{ id: WORKFLOWS_ID, ref: '+alpha/workflows', name: 'workflows', lastChangedAt: '2026-11-20T03:00:00Z' }],
        total: 1
      }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.context.recent': (input: { id: string; bound: number }) => ({
        state: 'ok',
        rows: [],
        total: 0,
        bound: input.bound
      }),
      'temper.search': (input: Asked) => {
        options.asked?.push(input)
        return (options.answer?.(input) ?? okAnswer(input)) as never
      },
      'temper.resource.detail': (input: { id: string }) => ({
        state: 'ok' as const,
        detail: {
          id: input.id,
          ref: `the-side-rail-design-${input.id}`,
          title: 'The side rail design',
          docType: 'research',
          stage: null,
          status: null,
          contextRef: '+alpha/workflows',
          properties: [{ label: 'doc_type', value: 'research' }]
        }
      }),
      'temper.launch.links': () => ({ state: 'ok' as const, links: [] })
    }
  })
}

async function openSearch(): Promise<void> {
  await mounted?.select({ type: 'Tabs', label: 'temper view' }, 'search')
}

const FIELD = { type: 'Input', label: 'search everything' }

test('search asks nothing until words are submitted, and an empty submit asks nothing', async () => {
  const asked: Asked[] = []
  mounted = await mount(panel, { host: servedHost({ asked }) })
  await openSearch()
  assert.ok(mounted.find(FIELD), 'the field stands')
  assert.ok(mounted.find({ text: /^Type words and press Enter to search everything you can read/ }))
  await mounted.type(FIELD, '   ', { submit: true })
  assert.deepEqual(asked, [], 'blank words ask nothing')
  assert.equal(mounted.find({ type: 'Heading', text: /^exact/ }), null, 'no group stands for an unasked search')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('the answer stands in two groups that never merge, each saying whether more matched', async () => {
  const asked: Asked[] = []
  mounted = await mount(panel, { host: servedHost({ asked }) })
  await openSearch()
  await mounted.type(FIELD, 'side rail', { submit: true })

  assert.deepEqual(asked, [{ query: 'side rail' }], 'one read: the words, no scope')
  assert.equal('owner' in (asked[0] ?? {}), false, 'no "yours" narrowing rides the read (R2)')
  assert.ok(mounted.find({ text: 'Results for “side rail” in everything you can read.' }))

  // Two lists, each its own: the resource both arms found stands in both.
  const exact = mounted.find({ type: 'List', label: 'exact' })
  const wide = mounted.find({ type: 'List', label: 'by meaning' })
  assert.ok(exact, 'the exact group is its own list')
  assert.ok(wide, 'the by-meaning group is its own list')
  assert.ok(mounted.find({ type: 'Heading', text: 'exact 2' }))
  assert.ok(mounted.find({ type: 'Heading', text: 'by meaning 2' }))
  assert.equal(
    mounted.findAll({ type: 'ListItem', label: 'The side rail design' }).length,
    2,
    'a resource in both arms stands in both groups — never merged into one list'
  )
  const task = mounted.find({ type: 'ListItem', label: 'A side rail task' })
  assert.equal(task?.props.description, 'task · in progress · +alpha/workflows')
  assert.equal(task?.props.icon, 'hammer')

  // Each group says, in its own sentence, that more matched past what it shows.
  assert.ok(mounted.find({ text: '2 results matching these words; more not shown.' }), "exact's truncated is said")
  assert.ok(
    mounted.find({ text: '2 results similar in meaning from a draw of the 100 nearest passages; more not shown.' }),
    "by meaning's truncated and its draw are said"
  )
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('an arm that matched everything it could says all; one that matched nothing says why', async () => {
  mounted = await mount(panel, {
    host: servedHost({
      answer: (input) =>
        okAnswer(input, {
          exact: { rows: [], reason: 'no_match', truncated: false },
          wide: { rows: [BOTH], truncated: false, draw: { kind: 'exhaustive' } }
        })
    })
  })
  await openSearch()
  await mounted.type(FIELD, 'zzq', { submit: true })
  assert.ok(mounted.find({ type: 'Heading', text: 'exact 0' }))
  assert.ok(mounted.find({ text: '— No results matching these words — try different words.' }))
  assert.ok(mounted.find({ text: 'All 1 result similar in meaning.' }), 'an exhaustive read with nothing more is all')
  assert.deepEqual(mounted.errors, [])
})

test('a degraded meaning arm is a warning callout, and the exact group stands beside it', async () => {
  mounted = await mount(panel, {
    host: servedHost({
      answer: (input) => okAnswer(input, { wide: { rows: [], reason: 'no_match', degraded: true, draw: null } })
    })
  })
  await openSearch()
  await mounted.type(FIELD, 'side rail', { submit: true })
  assert.ok(
    mounted.find({ type: 'Callout', label: "Meaning-match couldn't run just now" }),
    'degraded is said as a warning in words'
  )
  assert.equal(mounted.find({ type: 'List', label: 'by meaning' }), null, 'no list stands as its answer')
  assert.equal(
    mounted.find({ text: /^— No results similar in meaning/ }),
    null,
    'nor an empty line that reads like "nothing matched"'
  )
  assert.ok(mounted.find({ type: 'List', label: 'exact' }), 'the exact group is unaffected')
  assert.deepEqual(mounted.errors, [])
})

test('a pressed result opens its record; Back returns to the answer', async () => {
  mounted = await mount(panel, { host: servedHost() })
  await openSearch()
  await mounted.type(FIELD, 'side rail', { submit: true })
  await mounted.press({ type: 'ListItem', label: 'A panel beside the editor' })
  assert.equal(mounted.find({ type: 'Tabs' }), null, 'the detail holds the panel')
  assert.ok(mounted.find({ type: 'Heading', text: 'The side rail design' }), "the record's detail stands")
  await mounted.press({ text: 'Back' })
  assert.ok(mounted.find({ type: 'Heading', text: 'exact 2' }), 'back lands on the answer, still held')
  assert.deepEqual(mounted.errors, [])
})

test("a context's search is the same read scoped by its id, with no owner", async () => {
  const asked: Asked[] = []
  mounted = await mount(panel, { host: servedHost({ asked }) })
  await mounted.press({ type: 'ListItem', label: 'workflows' })
  const field = { type: 'Input', label: 'search +alpha/workflows' }
  assert.ok(mounted.find(field), "the context view holds Search's field")
  assert.deepEqual(asked, [], 'it asks nothing until asked')
  await mounted.type(field, 'side rail', { submit: true })
  assert.deepEqual(asked, [{ query: 'side rail', contextId: WORKFLOWS_ID }], 'scoped by the bare id')
  assert.equal('owner' in (asked[0] ?? {}), false, 'no "yours" narrowing (R2)')
  assert.ok(mounted.find({ text: 'Results for “side rail” in +alpha/workflows.' }))
  assert.ok(mounted.find({ type: 'List', label: 'exact' }))
  assert.ok(mounted.find({ type: 'List', label: 'by meaning' }))

  // The everything scope holds nothing of the context's question.
  await mounted.press({ text: 'Back' })
  await openSearch()
  assert.ok(mounted.find({ text: /^Type words and press Enter to search everything you can read/ }))
  assert.deepEqual(mounted.errors, [])
})

test('search keeps the region states: failed, signed out', async () => {
  mounted = await mount(panel, {
    host: servedHost({ answer: () => ({ state: 'failed', message: 'temper answered 503 on the search' }) })
  })
  await openSearch()
  await mounted.type(FIELD, 'side rail', { submit: true })
  assert.ok(mounted.find({ type: 'Callout', label: 'search unavailable — nothing here was read.' }))
  assert.ok(mounted.find({ text: 'temper answered 503 on the search' }))
  await mounted.unmount()

  mounted = await mount(panel, {
    host: servedHost({
      answer: () => ({ state: 'not-connected', message: 'temper is not connected — sign in with the temper CLI' })
    })
  })
  await openSearch()
  await mounted.type(FIELD, 'side rail', { submit: true })
  assert.ok(mounted.find({ label: 'temper is not connected' }))
  assert.deepEqual(mounted.errors, [])
})

test('a run that reopens on Search owes the question it held', async () => {
  const asked: Asked[] = []
  mounted = await mount(panel, {
    host: servedHost({ asked }),
    persisted: { plugin: { 'active-tab': 'search', 'search-asked': { everything: 'side rail' } } }
  })
  await mounted.settled()
  assert.deepEqual(asked, [{ query: 'side rail' }])
  assert.ok(mounted.find({ type: 'Heading', text: 'exact 2' }))
  assert.deepEqual(mounted.errors, [])
})
