// Explore: team → context (build item 8). Against mockHost request answers: the Explore tab
// lists teams, each with its contexts, then the people whose contexts the person can read; a
// pressed context — from Explore, or a place on Home — pushes the same context view, whose read
// is scoped by the context's id and carries no `owner` (R2); the view holds its recently
// updated items, each opening its record's detail, Show more growing the list, and the search
// slot named for the Search build. It reads the panel alone: the request answers are fixture
// data, typed here rather than imported, so this one file stands on its own.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

const WORKFLOWS_ID = '11111111-1111-7111-8111-111111111111'
const CORPUS_ID = '33333333-3333-7333-8333-333333333333'
const NOTES_ID = '55555555-5555-7555-8555-555555555555'
const TASK_ID = '00000000-0000-7000-8000-0000000000f1'

const NOT_CONNECTED = {
  state: 'not-connected' as const,
  message: 'temper is not connected — sign in with the temper CLI'
}

const EXPLORE = {
  state: 'ok' as const,
  contextCount: 3,
  owners: [
    {
      ownerRef: '+alpha',
      kind: 'team' as const,
      contexts: [
        { id: CORPUS_ID, ref: '+alpha/corpus', name: 'corpus', resourceCount: 120 },
        { id: WORKFLOWS_ID, ref: '+alpha/workflows', name: 'workflows', resourceCount: 7 }
      ]
    },
    {
      ownerRef: '@someone',
      kind: 'person' as const,
      contexts: [{ id: NOTES_ID, ref: '@someone/notes', name: 'notes', resourceCount: 1 }]
    }
  ]
}

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

/** Twelve items live in each context; the read answers the asked bound of them. */
const CONTEXT_ITEMS = [
  summary('f1', 'A task in the context', 'task', 'backlog'),
  ...Array.from({ length: 11 }, (_, n) => summary(`e${n.toString(16)}`, `Item ${n + 2}`, 'research'))
]

type Asked = { id: string; bound: number }

function servedHost(options: {
  explore?: unknown
  contextAnswer?: (input: Asked) => unknown
  asked?: Asked[]
  exploreAsks?: { count: number }
} = {}) {
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
      'temper.explore.contexts': () => {
        if (options.exploreAsks !== undefined) {
          options.exploreAsks.count += 1
        }
        return (options.explore ?? EXPLORE) as never
      },
      'temper.context.recent': (input: Asked) => {
        options.asked?.push(input)
        return (options.contextAnswer?.(input) ?? {
          state: 'ok',
          rows: CONTEXT_ITEMS.slice(0, input.bound),
          total: CONTEXT_ITEMS.length,
          bound: input.bound
        }) as never
      },
      'temper.resource.detail': (input: { id: string }) => ({
        state: 'ok' as const,
        detail: {
          id: input.id,
          ref: `a-task-in-the-context-${input.id}`,
          title: 'A task in the context',
          docType: 'task',
          stage: 'backlog',
          status: null,
          contextRef: '+alpha/workflows',
          properties: [{ label: 'doc_type', value: 'task' }]
        }
      }),
      'temper.launch.links': () => ({ state: 'ok' as const, links: [] }),
      'temper.work.records': () => ({ state: 'ok' as const, records: [], recordable: [] }),
      'temper.task.claim': () => ({ state: 'ok' as const, claim: null })
    }
  })
}

async function openExplore(): Promise<void> {
  await mounted?.select({ type: 'Tabs', label: 'temper view' }, 'explore')
}

test('explore lists teams, each with its contexts, then people — every readable context', async () => {
  const exploreAsks = { count: 0 }
  mounted = await mount(panel, { host: servedHost({ exploreAsks }) })
  assert.equal(exploreAsks.count, 0, 'explore reads nothing until it is shown')
  await openExplore()
  assert.equal(exploreAsks.count, 1, 'shown, explore reads its contexts once')

  assert.ok(mounted.find({ type: 'Heading', text: 'teams 1' }), 'the teams region counts its teams')
  assert.ok(mounted.find({ type: 'Heading', text: 'people 1' }), 'the people whose contexts are readable follow')
  const team = mounted.find({ type: 'Collapsible', label: '+alpha' })
  assert.notEqual(team, null, 'a team is a collapsible titled by its ref')
  assert.equal(team?.props.description, 'team · 2 contexts · 127 resources', 'what it holds is said before it opens')
  assert.equal(mounted.find({ label: 'workflows' }), null, 'a team waits collapsed')
  assert.ok(mounted.find({ text: 'All 3 contexts you can read.' }), 'explore says what it covers')

  await mounted.toggle({ type: 'Collapsible', label: '+alpha' })
  const row = mounted.find({ type: 'ListItem', label: 'workflows' })
  assert.notEqual(row, null, 'opened, the team lists its contexts')
  assert.equal(row?.props.icon, 'folder')
  assert.equal(row?.props.description, '+alpha/workflows · 7 resources', 'each context carries its ref and count')
  assert.deepEqual(mounted.persisted.plugin['explore-open'], { '+alpha': true }, 'the open team is device-local view state')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  assert.deepEqual(mounted.warnings, [])
})

test('a pressed context shows its recently updated items, read by its id with no owner', async () => {
  const asked: Asked[] = []
  mounted = await mount(panel, { host: servedHost({ asked }) })
  await openExplore()
  await mounted.toggle({ type: 'Collapsible', label: '+alpha' })
  await mounted.press({ label: 'workflows' })

  assert.equal(mounted.find({ type: 'Tabs' }), null, 'the context view holds the panel')
  assert.ok(mounted.find({ type: 'Heading', text: 'workflows' }), 'the view is titled by the context name')
  assert.ok(mounted.find({ text: '+alpha/workflows' }), 'its ref under the name')
  assert.deepEqual(asked, [{ id: WORKFLOWS_ID, bound: 8 }], 'one read, by the bare id, at the ways-in bound')
  assert.equal('owner' in (asked[0] ?? {}), false, 'no "yours" narrowing rides the read (R2)')

  assert.ok(mounted.find({ type: 'Heading', text: 'recently updated 12' }))
  const first = mounted.find({ type: 'ListItem', label: 'A task in the context' })
  assert.equal(first?.props.description, 'task · backlog')
  assert.equal(first?.props.icon, 'hammer')
  assert.ok(mounted.find({ text: /8 of 12 resources in \+alpha\/workflows/ }), 'the view says what it omits')

  // The search slot stands named for the Search build, reading nothing.
  assert.ok(mounted.find({ type: 'Heading', text: 'search in this context' }))
  assert.ok(mounted.find({ text: /^Search within \+alpha\/workflows arrives with the Search build/ }))

  // Show more grows the list in place, by the same step and the same read.
  await mounted.press({ text: 'Show more' })
  assert.deepEqual(asked.at(-1), { id: WORKFLOWS_ID, bound: 16 })
  assert.ok(mounted.find({ label: 'Item 12' }), 'grown, every item stands')
  assert.equal(mounted.find({ text: 'Show more' }), null, 'nothing left to grow')

  // An item opens its record's detail on top of the context; Back returns to the context, then Explore.
  await mounted.press({ label: 'A task in the context' })
  assert.ok(mounted.find({ text: 'task' }), 'the record detail leads with its doc-type word')
  await mounted.press({ text: 'Back' })
  assert.ok(mounted.find({ type: 'Heading', text: 'search in this context' }), 'back lands on the context')
  await mounted.press({ text: 'Back' })
  assert.ok(mounted.find({ type: 'Heading', text: 'teams 1' }), 'back again lands on explore')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
  assert.deepEqual(mounted.warnings, [])
})

test('a place on home opens the same context view', async () => {
  const asked: Asked[] = []
  mounted = await mount(panel, { host: servedHost({ asked }) })
  const place = mounted.find({ type: 'ListItem', label: 'workflows' })
  assert.ok(place?.props.onPress, 'a place is a press')
  await mounted.press({ type: 'ListItem', label: 'workflows' })

  assert.ok(mounted.find({ type: 'Heading', text: 'workflows' }), 'the context view stands')
  assert.ok(mounted.find({ type: 'Heading', text: 'search in this context' }))
  assert.deepEqual(asked, [{ id: WORKFLOWS_ID, bound: 8 }], 'the place\'s own context, read by its id')
  await mounted.press({ text: 'Back' })
  assert.ok(mounted.find({ type: 'Heading', text: 'places 1' }), 'back returns to home')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('explore and the context view keep the region states: failed, empty, signed out', async () => {
  mounted = await mount(panel, {
    host: servedHost({
      explore: { state: 'failed', message: 'temper answered 503 on the contexts read' },
      contextAnswer: () => ({ state: 'ok', rows: [], total: 0, bound: 8 })
    })
  })
  await openExplore()
  assert.ok(
    mounted.find({ type: 'Callout', label: 'teams unavailable — nothing here was read.' }),
    'a failed read titles its callout in the house words'
  )
  assert.ok(mounted.find({ text: 'temper answered 503 on the contexts read' }))
  await mounted.unmount()

  // An empty context keeps its words and its count at 0.
  mounted = await mount(panel, {
    host: servedHost({ contextAnswer: () => ({ state: 'ok', rows: [], total: 0, bound: 8 }) })
  })
  await mounted.press({ type: 'ListItem', label: 'workflows' })
  assert.ok(mounted.find({ type: 'Heading', text: 'recently updated 0' }))
  assert.ok(mounted.find({ text: '— No resources in +alpha/workflows.' }))
  await mounted.unmount()

  // The grant lost after Home answered: the context view says temper is not connected.
  mounted = await mount(panel, { host: servedHost({ contextAnswer: () => NOT_CONNECTED }) })
  await mounted.press({ type: 'ListItem', label: 'workflows' })
  assert.ok(mounted.find({ label: 'temper is not connected' }))
  assert.deepEqual(mounted.errors, [])
})

test('a run that reopens on a context owes its read', async () => {
  const asked: Asked[] = []
  mounted = await mount(panel, {
    host: servedHost({ asked }),
    persisted: {
      plugin: { 'detail-stack': [{ kind: 'context', id: CORPUS_ID, ref: '+alpha/corpus', name: 'corpus' }] }
    }
  })
  await mounted.settled()
  assert.ok(mounted.find({ type: 'Heading', text: 'corpus' }))
  assert.deepEqual(asked, [{ id: CORPUS_ID, bound: 8 }])
  assert.deepEqual(mounted.errors, [])
})
