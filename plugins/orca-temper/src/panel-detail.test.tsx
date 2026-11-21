// The pushed detail, against mockHost request answers: exactly the worker's meta in temper-ui's
// order, the body never shown, a goal's linked tasks with their omission sentence, and the way
// out lit only by the person's https:// web address. The detail is stood up the way a carried
// run stands it up: the stack seeded under the atom's key, so setup owes the reads. It reads
// the panel alone: the request answers are fixture data, typed here rather than imported, so
// this one file stands on its own.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import { metaItems } from './look'
import * as panel from './panel'
import type { RecordDetailOutput } from './protocol'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

const TASK_ID = '00000000-0000-7000-8000-0000000000d1'
const SECOND_TASK_ID = '00000000-0000-7000-8000-0000000000d2'
const GOAL_ID = '00000000-0000-7000-8000-0000000000e1'

const NOT_CONNECTED = {
  state: 'not-connected' as const,
  message: 'temper is not connected — sign in with the temper CLI'
}

/** One record's meta, as the worker answers it — the body's words appear nowhere. */
const TASK_DETAIL = {
  state: 'ok' as const,
  detail: {
    id: TASK_ID,
    ref: `the-item-detail-${TASK_ID}`,
    title: 'The item detail',
    docType: 'task',
    stage: 'in-progress',
    status: null,
    contextRef: '+temper-dev/contrib',
    properties: [
      { label: 'doc_type', value: 'task' },
      { label: 'temper-stage', value: 'in-progress' },
      { label: 'temper-mode', value: 'build' },
      { label: 'temper-effort', value: 'small' },
      { label: 'context', value: '+temper-dev/contrib' },
      { label: 'owner', value: 'fixture-owner' },
      { label: 'updated', value: '2026-11-20T01:00:00Z' }
    ]
  }
}

const SECOND_TASK_DETAIL = {
  state: 'ok' as const,
  detail: { ...TASK_DETAIL.detail, id: SECOND_TASK_ID, title: 'Task one' }
}

const GOAL_DETAIL = {
  state: 'ok' as const,
  detail: {
    id: GOAL_ID,
    ref: `the-goal-${GOAL_ID}`,
    title: 'The in-force goal',
    docType: 'goal',
    stage: null,
    status: 'active',
    contextRef: '+temper-dev/contrib',
    properties: [{ label: 'doc_type', value: 'goal' }]
  }
}

/** The tasks the goal's `advances` edges recorded — two answering of nine. */
const LINKED_TASKS = {
  state: 'ok' as const,
  rows: [
    {
      id: SECOND_TASK_ID,
      ref: `row-${SECOND_TASK_ID}`,
      title: 'Task one',
      docType: 'task',
      contextRef: '+temper-dev/contrib',
      updated: '2026-11-20T00:00:00Z',
      stage: 'done'
    },
    {
      id: TASK_ID,
      ref: `row-${TASK_ID}`,
      title: 'The item detail',
      docType: 'task',
      contextRef: '+temper-dev/contrib',
      updated: '2026-11-20T01:00:00Z',
      stage: 'in-progress'
    }
  ],
  total: 9,
  bound: 8
}

function servedHost(options: { webUrl?: string; detail?: RecordDetailOutput } = {}): ReturnType<typeof mockHost> {
  const detailAnswer = options.detail
  const detailRequest =
    detailAnswer !== undefined
      ? (): RecordDetailOutput => detailAnswer
      : (input: { id: string }): RecordDetailOutput =>
          input.id === TASK_ID
            ? TASK_DETAIL
            : input.id === SECOND_TASK_ID
              ? SECOND_TASK_DETAIL
              : input.id === GOAL_ID
                ? GOAL_DETAIL
                : { state: 'failed', message: `nothing answers for ${input.id}` }
  return mockHost({
    ...(options.webUrl !== undefined ? { settings: { webUrl: options.webUrl } } : {}),
    requests: {
      'temper.capabilities': () => ({ granted: ['settings:own'] }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => ({ state: 'ok', sessionCount: 0, handoff: null }),
      'temper.home.way-in': () => ({ state: 'ok', id: 'goals', label: 'goals', scope: 'goals of yours', rows: [], total: 0, bound: 8 }),
      'temper.home.places': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.resource.detail': detailRequest,
      'temper.goal.tasks': () => LINKED_TASKS
    }
  })
}

function seededStack(top: { id: string; ref: string; title: string; docType: string }) {
  return { persisted: { plugin: { 'detail-stack': [top] } } }
}

test('a task detail shows exactly the meta the worker answered, in temper-ui\'s order, no body', async () => {
  mounted = await mount(panel, {
    host: servedHost(),
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  // The meta is collapsed by default: nothing of it shows until the person opens it.
  assert.equal(mounted.find({ type: 'KeyValue' }), null, 'the meta waits collapsed')
  await mounted.toggle({ type: 'Collapsible' })
  const kv = mounted.find({ type: 'KeyValue' })
  assert.notEqual(kv, null, 'the meta table is on the detail')
  assert.deepEqual(kv?.props.items, metaItems(TASK_DETAIL.detail))
  assert.deepEqual(
    (kv?.props.items as { label: string }[]).map((item) => item.label),
    ['temper-stage', 'temper-mode', 'temper-effort', 'context', 'owner', 'updated', 'ref'],
    'temper-ui\'s order, without the doc_type row the header already says, the ref closing it'
  )
  assert.deepEqual(
    (kv?.props.items as { label: string; value: unknown; code?: boolean }[]).slice(-2),
    [
      { label: 'updated', value: '20 Nov 2026, 01:00 UTC' },
      { label: 'ref', value: TASK_DETAIL.detail.ref, code: true }
    ],
    'updated reads as a time; the ref is mono'
  )
  assert.equal(
    (kv?.props as { label?: string }).label,
    'meta',
    'the table claims the meta and nothing more'
  )
  // The body stays out: the words it would open behind are on the panel and nothing of a body.
  assert.ok(
    mounted.find({ text: 'The full record opens in temper — only the meta shows here.' }),
    'the muted line says where the full record lives'
  )
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('the way out opens <webUrl>/vault/r/<id> over https, once the person named the host', async () => {
  mounted = await mount(panel, {
    host: servedHost({ webUrl: 'https://web-temper.example/' }),
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  const button = mounted.find({ text: 'Open in temper' })
  assert.notEqual(button, null)
  assert.equal(button?.disabled, false, 'an https:// web address lights the way out')
  await mounted.press({ text: 'Open in temper' })

  const urls = mounted.host.callsOf('shell.openExternal')
  assert.deepEqual(urls, [{ url: `https://web-temper.example/vault/r/${TASK_ID}` }])
  assert.deepEqual(mounted.refusals, [])
  assert.deepEqual(mounted.errors, [])
})

test('without the setting the way out is disabled and names the setting, never a guess', async () => {
  mounted = await mount(panel, {
    host: servedHost(),
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  const button = mounted.find({ text: 'Open in temper' })
  assert.notEqual(button, null)
  assert.equal(button?.disabled, true)
  assert.equal(mounted.host.callsOf('shell.openExternal').length, 0, 'a disabled button opens nothing')
  assert.ok(
    mounted.find({ text: "Set 'Temper web address' in the plugin's settings — the address is never guessed." }),
    'the disabled way out names the setting'
  )
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('an address that is not https:// never lights the way out', async () => {
  mounted = await mount(panel, {
    host: servedHost({ webUrl: 'http://web-temper.example' }),
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  assert.equal(mounted.find({ text: 'Open in temper' })?.disabled, true)
  assert.equal(mounted.host.callsOf('shell.openExternal').length, 0)
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('a goal detail lists its linked tasks with the label and omission sentence', async () => {
  mounted = await mount(panel, {
    host: servedHost(),
    ...seededStack({ id: GOAL_ID, ref: '', title: '', docType: 'goal' })
  })
  await mounted.settled()

  assert.ok(mounted.find({ type: 'Heading', text: 'linked tasks 9' }), 'the list is labelled linked tasks')
  assert.ok(
    mounted.find({ text: '2 of 9 linked tasks; 7 not shown.' }),
    'the omission sentence stands under the bound'
  )
  assert.ok(mounted.find({ label: 'Task one' }), 'the linked tasks are on the detail')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('pressing a linked task pushes its detail', async () => {
  mounted = await mount(panel, {
    host: servedHost(),
    ...seededStack({ id: GOAL_ID, ref: '', title: '', docType: 'goal' })
  })
  await mounted.settled()

  await mounted.press({ label: 'Task one' })
  await mounted.settled()

  // The pushed task's own detail read answers, and the goal's list is gone from view.
  await mounted.toggle({ type: 'Collapsible' })
  const kv = mounted.find({ type: 'KeyValue' })
  assert.equal(
    (kv?.props as { items?: { label: string; value: string }[] }).items?.find((item) => item.label === 'ref')?.value,
    TASK_DETAIL.detail.ref,
    'the pushed task\'s own detail drew the meta'
  )
  assert.equal(mounted.find({ type: 'Heading', text: 'linked tasks 9' }), null, 'the goal\'s list is not on the task detail')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('signed out, the pushed detail is the refusal and no item data answers', async () => {
  mounted = await mount(panel, {
    host: servedHost({ detail: NOT_CONNECTED }),
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  const state = mounted.find({ type: 'EmptyState' })
  assert.notEqual(state, null, 'the signed-out refusal carries the detail')
  assert.match(String(state?.props.description), /sign in with the temper CLI/)
  assert.equal(mounted.find({ type: 'KeyValue' }), null, 'no meta answers a refusal')
  assert.equal(mounted.find({ text: 'The item detail' }), null, 'no item data rides the refusal')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('the detail header names the doc type, then the state as a badge holding its word', async () => {
  const cases: { detail: RecordDetailOutput; word: string; tone: string }[] = [
    { detail: TASK_DETAIL, word: 'in progress', tone: 'accent' },
    { detail: { state: 'ok', detail: { ...TASK_DETAIL.detail, stage: 'done' } }, word: 'done', tone: 'success' },
    { detail: { state: 'ok', detail: { ...TASK_DETAIL.detail, stage: 'backlog' } }, word: 'backlog', tone: 'neutral' },
    { detail: GOAL_DETAIL, word: 'active', tone: 'accent' }
  ]
  for (const one of cases) {
    mounted = await mount(panel, {
      host: servedHost({ detail: one.detail }),
      ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
    })
    await mounted.settled()
    const badge = mounted.find({ type: 'Badge', text: one.word })
    assert.notEqual(badge, null, `the ${one.word} badge holds its word`)
    assert.equal(badge?.props.tone, one.tone, `${one.word} is ${one.tone}`)
    assert.ok(mounted.find({ type: 'Heading', text: one.detail.state === 'ok' ? one.detail.detail.title : '' }))
    assert.deepEqual(mounted.errors, [])
    await mounted.unmount()
    mounted = undefined
  }
})

test('one solid accent primary act; Open body and Open in temper outlined, each with its icon', async () => {
  mounted = await mount(panel, {
    host: servedHost({ webUrl: 'https://web-temper.example' }),
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()
  const solid = mounted.findAll({ type: 'Button' }).filter((button) => button.props.variant === 'solid')
  assert.deepEqual(solid.map((button) => button.text), ['Resume task'], 'one primary act on the view')
  assert.equal(solid[0]?.props.tone, 'accent')
  assert.equal(solid[0]?.props.icon, 'play')
  const body = mounted.find({ type: 'Button', text: 'Open body' })
  assert.equal(body?.props.variant, 'outline')
  assert.equal(body?.props.icon, 'file-text')
  const out = mounted.find({ type: 'Button', text: 'Open in temper' })
  assert.equal(out?.props.variant, 'outline')
  assert.equal(out?.props.icon, 'open-external')
  assert.equal(mounted.find({ type: 'IconButton' }), null, 'no act is an icon without words')
  assert.deepEqual(mounted.errors, [])
})

test('a goal\'s linked tasks wear the task icon and say their stage in words', async () => {
  mounted = await mount(panel, {
    host: servedHost(),
    ...seededStack({ id: GOAL_ID, ref: '', title: '', docType: 'goal' })
  })
  await mounted.settled()
  const done = mounted.find({ type: 'ListItem', label: 'Task one' })
  assert.equal(done?.props.icon, 'hammer')
  assert.equal(done?.props.description, 'task · done')
  const worked = mounted.find({ type: 'ListItem', label: 'The item detail' })
  assert.equal(worked?.props.description, 'task · in progress')
  assert.equal(mounted.find({ type: 'Button', text: 'Work this goal' })?.props.icon, 'rocket')
  assert.deepEqual(mounted.errors, [])
})
