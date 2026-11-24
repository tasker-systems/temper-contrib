// Search (build item 9). Against mockHost request answers: the Search sub-tab asks nothing
// until words are submitted; the answer stands in two groups that never merge — exact and by
// meaning — each saying in temper-design's sentences whether more matched; a degraded meaning
// arm is a warning callout, never an empty list; a pressed result opens its record's detail; a
// context view's search asks the same read scoped by the context's id; and no request carries
// `owner` (R2). The filters (0.2.1): a doc type rides the read only when chosen, the Search tab's
// context picker sends the picked context's bare id, each answer is cached under its filters,
// and the by-meaning sentence under a type on an unscoped search says the type narrowed the draw.
// The request answers are fixture data, typed here, so this file stands alone.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

const WORKFLOWS_ID = '11111111-1111-7111-8111-111111111111'
const RESEARCH_ID = '22222222-2222-7222-8222-222222222222'

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

type Asked = { query: string; contextId?: string; docType?: string }

function okAnswer(input: Asked, extra: { exact?: object; wide?: object } = {}) {
  return {
    state: 'ok' as const,
    engine: 'search' as const,
    query: input.query,
    contextId: input.contextId ?? null,
    docType: input.docType ?? null,
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
      'temper.explore.contexts': () => ({
        state: 'ok' as const,
        contextCount: 2,
        owners: [
          {
            ownerRef: '+alpha',
            kind: 'team' as const,
            contexts: [
              { id: WORKFLOWS_ID, ref: '+alpha/workflows', name: 'workflows', resourceCount: 3 },
              { id: RESEARCH_ID, ref: '+alpha/research', name: 'research', resourceCount: 9 }
            ]
          }
        ]
      }),
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

const TYPE = { type: 'Select', label: 'type' }
const IN = { type: 'Select', label: 'in' }

test('a doc type rides the read only when chosen, and both groups name it', async () => {
  const asked: Asked[] = []
  mounted = await mount(panel, { host: servedHost({ asked }) })
  await openSearch()
  await mounted.type(FIELD, 'side rail', { submit: true })
  assert.deepEqual(asked, [{ query: 'side rail' }], 'any type: no doc_type rides the read')

  await mounted.select(TYPE, 'research')
  assert.deepEqual(asked[1], { query: 'side rail', docType: 'research' }, 'a held question is asked again under the type')
  assert.equal('owner' in (asked[1] ?? {}), false, 'no "yours" narrowing (R2)')
  assert.ok(mounted.find({ text: 'Results for “side rail” in research records in everything you can read.' }))
  assert.ok(mounted.find({ text: '2 research results matching these words; more not shown.' }), 'the exact group names the type')
  assert.ok(mounted.find({ type: 'List', label: 'exact' }))
  assert.ok(mounted.find({ type: 'List', label: 'by meaning' }), 'the two groups still stand apart')

  await mounted.select(TYPE, 'any-type')
  assert.deepEqual(asked[2], { query: 'side rail' }, 'back to any type: doc_type absent again')
  assert.ok(mounted.find({ text: 'Results for “side rail” in everything you can read.' }))
  assert.deepEqual(mounted.errors, [])
})

test('the type filter lists core doc types from temper-design, after any type', async () => {
  mounted = await mount(panel, { host: servedHost() })
  await openSearch()
  const options = (mounted.find(TYPE)?.props.options ?? []) as { value: string }[]
  assert.equal(options[0]?.value, 'any-type')
  assert.deepEqual(
    options.slice(1).map((option) => option.value),
    ['task', 'goal', 'commitment', 'session', 'memory', 'research', 'question', 'decision', 'principle', 'concept', 'domain', 'theme', 'fact', 'concern']
  )
  assert.deepEqual(mounted.errors, [])
})

test("by meaning under a type on an unscoped search says the type narrowed the draw", async () => {
  mounted = await mount(panel, {
    host: servedHost({ answer: (input) => okAnswer(input, { wide: { rows: [BOTH], truncated: false } }) })
  })
  await openSearch()
  await mounted.select(TYPE, 'research')
  await mounted.type(FIELD, 'side rail', { submit: true })
  assert.ok(
    mounted.find({
      text:
        '1 research result similar in meaning from a draw of the 100 nearest passages of any type; past the draw not reported. ' +
        'The type narrowed that draw — research records outside it were never looked at.'
    }),
    'the sentence says the type narrowed the draw, never that every research record was looked at'
  )
  assert.deepEqual(mounted.errors, [])
})

test('a type on a scoped search is an exhaustive read, said as all', async () => {
  const asked: Asked[] = []
  mounted = await mount(panel, {
    host: servedHost({
      asked,
      answer: (input) => okAnswer(input, { wide: { rows: [BOTH], truncated: false, draw: { kind: 'exhaustive' } } })
    })
  })
  await mounted.press({ type: 'ListItem', label: 'workflows' })
  assert.equal(mounted.find(IN), null, "a context's own search shows no picker")
  await mounted.select(TYPE, 'research')
  await mounted.type({ type: 'Input', label: 'search +alpha/workflows' }, 'side rail', { submit: true })
  assert.deepEqual(asked, [{ query: 'side rail', contextId: WORKFLOWS_ID, docType: 'research' }])
  assert.ok(mounted.find({ text: 'Results for “side rail” in research records in +alpha/workflows.' }))
  assert.ok(mounted.find({ text: 'All 1 research result similar in meaning.' }))
  assert.equal(mounted.find({ text: /narrowed that draw/ }), null, 'no draw to narrow on a scoped read')
  assert.deepEqual(mounted.errors, [])
})

test("the picker lists Explore's contexts and sends the picked one's bare id", async () => {
  const asked: Asked[] = []
  mounted = await mount(panel, { host: servedHost({ asked }) })
  await openSearch()
  await mounted.settled()
  const options = (mounted.find(IN)?.props.options ?? []) as { value: string; label: string }[]
  assert.deepEqual(
    options.map((option) => option.label),
    ['Everything readable', '+alpha/workflows', '+alpha/research'],
    "everything readable, then the contexts Explore's read answered"
  )
  await mounted.select(IN, RESEARCH_ID)
  assert.equal(asked.length, 0, 'picking asks nothing until words are held')
  await mounted.type(FIELD, 'side rail', { submit: true })
  assert.deepEqual(asked, [{ query: 'side rail', contextId: RESEARCH_ID }], 'the bare UUID, never the decorated ref')
  assert.match((asked[0] as Asked | undefined)?.contextId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal('owner' in (asked[0] ?? {}), false, 'no "yours" narrowing (R2)')
  assert.ok(mounted.find({ text: 'Results for “side rail” in +alpha/research.' }))

  await mounted.select(TYPE, 'task')
  assert.deepEqual(asked[1], { query: 'side rail', contextId: RESEARCH_ID, docType: 'task' }, 'both filters ride together')
  assert.ok(mounted.find({ text: 'Results for “side rail” in task records in +alpha/research.' }))

  await mounted.select(IN, 'everything')
  assert.deepEqual(asked[2], { query: 'side rail', docType: 'task' }, 'everything readable: no context_ref')
  assert.deepEqual(mounted.errors, [])
})

test('an answer is never shown under a filter it was not asked with', async () => {
  const asked: Asked[] = []
  const TASK_ONLY = summary('t1', 'Only under the task filter', 'task')
  mounted = await mount(panel, {
    host: servedHost({
      asked,
      answer: (input) =>
        input.docType === 'task'
          ? okAnswer(input, { exact: { rows: [TASK_ONLY], truncated: false }, wide: { rows: [TASK_ONLY], truncated: false } })
          : okAnswer(input)
    })
  })
  await openSearch()
  await mounted.type(FIELD, 'side rail', { submit: true })
  assert.ok(mounted.find({ type: 'ListItem', label: 'A panel beside the editor' }))
  await mounted.select(TYPE, 'task')
  assert.equal(
    mounted.find({ type: 'ListItem', label: 'A panel beside the editor' }),
    null,
    "the any-type answer's rows do not stand under the task filter"
  )
  assert.equal(mounted.findAll({ type: 'ListItem', label: 'Only under the task filter' }).length, 2)
  assert.ok(mounted.find({ text: 'Results for “side rail” in task records in everything you can read.' }))

  // A new question under the task filter, then back to any type: asked again, never the old answer.
  await mounted.type(FIELD, ' launcher', { submit: true })
  await mounted.select(TYPE, 'any-type')
  assert.deepEqual(asked.at(-1), { query: 'side rail launcher' }, 'the held words are asked again under the filter')
  assert.ok(mounted.find({ text: 'Results for “side rail launcher” in everything you can read.' }))
  assert.deepEqual(mounted.errors, [])
})

test('the answer key changes with the type and the context', async () => {
  const { answerKey, EVERYTHING } = await import('./search')
  const context = { id: RESEARCH_ID, ref: '+alpha/research' }
  const keys = new Set([
    answerKey(EVERYTHING, { docType: null, context: null }),
    answerKey(EVERYTHING, { docType: 'task', context: null }),
    answerKey(EVERYTHING, { docType: null, context }),
    answerKey(EVERYTHING, { docType: 'task', context }),
    answerKey({ kind: 'context', id: WORKFLOWS_ID, ref: '+alpha/workflows' }, { docType: null, context: null }),
    answerKey({ kind: 'context', id: WORKFLOWS_ID, ref: '+alpha/workflows' }, { docType: 'task', context: null })
  ])
  assert.equal(keys.size, 6, 'every question its own key')
})

// Stage, status and tags (0.2.2): through a query plan, answered among the filter stage's count.

type PlanAsked = Asked & { stage?: string; status?: string; tags?: string[] }

function planAnswer(
  input: PlanAsked,
  extra: { among?: number; exact?: object; wide?: object } = {}
) {
  return {
    state: 'ok' as const,
    engine: 'plan' as const,
    query: input.query,
    contextId: input.contextId ?? null,
    docType: input.docType ?? null,
    stage: input.stage ?? null,
    status: input.status ?? null,
    tags: input.tags ?? [],
    among: extra.among ?? 31,
    exact: { rows: [BOTH, summary('b2', 'A side rail task', 'task', 'done')], more: false, ...extra.exact },
    wide: { rows: [summary('b3', 'A panel beside the editor', 'task', 'done'), BOTH], more: true, degraded: false, ...extra.wide }
  }
}

/** Answers the plan when a stage, a status or a tag rides the read, the search door otherwise. */
function planOrSearch(extra: Parameters<typeof planAnswer>[1] = {}) {
  return (input: PlanAsked) =>
    input.stage !== undefined || input.status !== undefined || (input.tags?.length ?? 0) > 0
      ? planAnswer(input, extra)
      : okAnswer(input)
}

const STAGE = { type: 'Select', label: 'stage' }
const STATUS = { type: 'Select', label: 'status' }
const TAGS = { type: 'Input', label: 'tags' }

test('the stage select stands only under task, the status select only under goal, from temper\'s values', async () => {
  mounted = await mount(panel, { host: servedHost() })
  await openSearch()
  assert.equal(mounted.find(STAGE), null, 'any type: no stage')
  assert.equal(mounted.find(STATUS), null, 'any type: no status')
  assert.ok(mounted.find(TAGS), 'tags stand under any type')
  await mounted.select(TYPE, 'task')
  const stages = (mounted.find(STAGE)?.props.options ?? []) as { value: string }[]
  assert.deepEqual(stages.map((option) => option.value), ['any-stage', 'backlog', 'in-progress', 'done', 'cancelled'])
  assert.equal(mounted.find(STATUS), null)
  await mounted.select(TYPE, 'goal')
  assert.equal(mounted.find(STAGE), null)
  const statuses = (mounted.find(STATUS)?.props.options ?? []) as { value: string }[]
  assert.deepEqual(statuses.map((option) => option.value), ['any-status', 'active', 'completed', 'paused', 'cancelled'])
  await mounted.select(TYPE, 'research')
  assert.equal(mounted.find(STAGE), null)
  assert.equal(mounted.find(STATUS), null)
  assert.deepEqual(mounted.errors, [])
})

test('a stage asks the plan; the answer names every filter and the scope, among M, the two arms apart', async () => {
  const asked: PlanAsked[] = []
  mounted = await mount(panel, { host: servedHost({ asked, answer: planOrSearch() }) })
  await openSearch()
  await mounted.type(FIELD, 'side rail', { submit: true })
  await mounted.select(TYPE, 'task')
  await mounted.select(STAGE, 'done')
  assert.deepEqual(asked.at(-1), { query: 'side rail', docType: 'task', stage: 'done' })
  assert.equal('owner' in (asked.at(-1) ?? {}), false, 'no "yours" narrowing (R2)')
  assert.ok(mounted.find({ text: 'Results for “side rail” in everything you can read, among 31 task records at done.' }))
  assert.ok(mounted.find({ type: 'List', label: 'exact' }), 'the exact arm is its own list')
  assert.ok(mounted.find({ type: 'List', label: 'by meaning' }), 'the meaning arm is its own list')
  assert.equal(mounted.findAll({ type: 'ListItem', label: 'The side rail design' }).length, 2, 'never merged')
  assert.ok(mounted.find({ text: 'All 2 of the 31 match these words.' }), 'exactly N back: all N')
  assert.ok(mounted.find({ text: 'The 2 closest in meaning of the 31; the rest not shown.' }))
  assert.equal(mounted.find({ text: /draw/ }), null, 'a bounded meaning arm has no draw to say')

  // Back to any stage: the search door again, exactly as before.
  await mounted.select(STAGE, 'any-stage')
  assert.deepEqual(asked.at(-1), { query: 'side rail', docType: 'task' })
  assert.ok(mounted.find({ text: 'Results for “side rail” in task records in everything you can read.' }))
  assert.deepEqual(mounted.errors, [])
})

test('the exact arm says more only when one past the page came back', async () => {
  mounted = await mount(panel, { host: servedHost({ answer: planOrSearch({ exact: { more: true } }) }) })
  await openSearch()
  await mounted.select(TYPE, 'goal')
  await mounted.select(STATUS, 'active')
  await mounted.type(FIELD, 'side rail', { submit: true })
  assert.ok(mounted.find({ text: 'Results for “side rail” in everything you can read, among 31 goal records at active.' }))
  assert.ok(mounted.find({ text: '2 shown of the 31; more match these words.' }), 'N+1 back: more')
  assert.equal(mounted.find({ text: /^All 2 of the 31/ }), null)
  assert.deepEqual(mounted.errors, [])
})

test('the meaning arm says all when it ranked every one of the M, and the shortfall when not', async () => {
  const { planMeaningSentence, planExactSentence } = await import('./search')
  const two = [BOTH, summary('b2', 'x', 'task')]
  assert.equal(planMeaningSentence({ rows: two, more: false }, 2), 'All 2 of the 2, closest in meaning first.')
  assert.equal(
    planMeaningSentence({ rows: two, more: false }, 5),
    'The 2 closest in meaning of the 5; the other 3 were not ranked by meaning.'
  )
  assert.equal(planMeaningSentence({ rows: two, more: true }, 30), 'The 2 closest in meaning of the 30; the rest not shown.')
  assert.equal(planExactSentence({ rows: [], more: false }, 30), 'None of the 30 match these words — try different words.')
})

test('a filter set admitting nothing says so — nothing was searched, never "no results"', async () => {
  mounted = await mount(panel, { host: servedHost({ answer: planOrSearch({ among: 0, exact: { rows: [] }, wide: { rows: [], more: false } }) }) })
  await mounted.press({ type: 'ListItem', label: 'workflows' })
  await mounted.select(TYPE, 'task')
  await mounted.select(STAGE, 'cancelled')
  await mounted.type({ type: 'Input', label: 'search +alpha/workflows' }, 'side rail', { submit: true })
  assert.ok(mounted.find({ text: 'No task records at cancelled in +alpha/workflows — nothing was searched for “side rail”.' }))
  assert.equal(mounted.find({ type: 'Heading', text: /^exact/ }), null, 'no arm stands to read as an answer')
  assert.equal(mounted.find({ text: /no results/i }), null)
  assert.deepEqual(mounted.errors, [])
})

test('a tag is added on Enter, matched all-of, said in the answer, and removed by its chip', async () => {
  const asked: PlanAsked[] = []
  mounted = await mount(panel, { host: servedHost({ asked, answer: planOrSearch() }) })
  await openSearch()
  await mounted.type(FIELD, 'side rail', { submit: true })
  await mounted.type(TAGS, ' orca ', { submit: true })
  assert.deepEqual(asked.at(-1), { query: 'side rail', tags: ['orca'] })
  await mounted.type(TAGS, 'rail', { submit: true })
  assert.deepEqual(asked.at(-1), { query: 'side rail', tags: ['orca', 'rail'] }, 'every tag rides the read')
  const before = asked.length
  await mounted.type(TAGS, 'orca', { submit: true })
  assert.equal(asked.length, before, 'a repeated tag adds nothing and asks nothing')
  assert.ok(mounted.find({ text: 'Results for “side rail” in everything you can read, among 31 records tagged orca and rail.' }))
  assert.ok(mounted.find({ type: 'Button', text: 'orca' }), 'each tag stands as a chip')
  await mounted.press({ type: 'Button', text: 'orca' })
  await mounted.press({ type: 'Button', text: 'rail' })
  assert.deepEqual(asked.at(-1), { query: 'side rail' }, 'no tag left: the search door again')
  assert.ok(mounted.find({ text: 'Results for “side rail” in everything you can read.' }))
  assert.deepEqual(mounted.errors, [])
})

test('a degraded meaning stage in a plan is the warning callout, the exact arm beside it', async () => {
  mounted = await mount(panel, { host: servedHost({ answer: planOrSearch({ wide: { rows: [], more: false, degraded: true } }) }) })
  await openSearch()
  await mounted.type(TAGS, 'orca', { submit: true })
  await mounted.type(FIELD, 'side rail', { submit: true })
  assert.ok(mounted.find({ type: 'Callout', label: "Meaning-match couldn't run just now" }))
  assert.equal(mounted.find({ type: 'List', label: 'by meaning' }), null)
  assert.equal(mounted.find({ text: /closest in meaning/ }), null, 'no meaning sentence stands for an arm that did not run')
  assert.ok(mounted.find({ type: 'List', label: 'exact' }), 'the exact arm still shows')
  assert.ok(mounted.find({ text: 'All 2 of the 31 match these words.' }))
  assert.deepEqual(mounted.errors, [])
})

test('a refused plan is a fault in the region, never an empty answer', async () => {
  mounted = await mount(panel, {
    host: servedHost({
      answer: () => ({
        state: 'failed',
        message: "temper refused the search plan (PLAN_REFUSED) — a defect in the plugin's plan, not an empty answer: exact: filter_not_applicable — no"
      })
    })
  })
  await openSearch()
  await mounted.type(TAGS, 'orca', { submit: true })
  await mounted.type(FIELD, 'side rail', { submit: true })
  assert.ok(mounted.find({ type: 'Callout', label: 'search unavailable — nothing here was read.' }))
  assert.ok(mounted.find({ text: /PLAN_REFUSED/ }))
  assert.equal(mounted.find({ type: 'Heading', text: /^exact/ }), null)
  assert.deepEqual(mounted.errors, [])
})

test('changing the type away from task drops the stage, so no hidden filter narrows the read', async () => {
  const asked: PlanAsked[] = []
  mounted = await mount(panel, { host: servedHost({ asked, answer: planOrSearch() }) })
  await openSearch()
  await mounted.type(FIELD, 'side rail', { submit: true })
  await mounted.select(TYPE, 'task')
  await mounted.select(STAGE, 'done')
  await mounted.select(TYPE, 'research')
  assert.deepEqual(asked.at(-1), { query: 'side rail', docType: 'research' }, 'the stage went with the task type')
  await mounted.select(TYPE, 'task')
  assert.equal(mounted.find(STAGE)?.props.value, 'any-stage')
  assert.deepEqual(mounted.errors, [])
})

test('the answer key changes with the stage, the status and each tag', async () => {
  const { answerKey, EVERYTHING } = await import('./search')
  const keys = [
    answerKey(EVERYTHING, { docType: 'task' }),
    answerKey(EVERYTHING, { docType: 'task', stage: 'done' }),
    answerKey(EVERYTHING, { docType: 'task', stage: 'backlog' }),
    answerKey(EVERYTHING, { docType: 'goal', status: 'active' }),
    answerKey(EVERYTHING, { docType: 'goal', status: 'paused' }),
    answerKey(EVERYTHING, { tags: ['orca'] }),
    answerKey(EVERYTHING, { tags: ['orca', 'rail'] }),
    answerKey(EVERYTHING, { tags: ['rail'] })
  ]
  assert.equal(new Set(keys).size, keys.length, 'every filter its own key')
  assert.equal(
    answerKey(EVERYTHING, { tags: ['orca', 'rail'] }),
    answerKey(EVERYTHING, { tags: ['rail', 'orca'] }),
    'all-of has no order'
  )
})
