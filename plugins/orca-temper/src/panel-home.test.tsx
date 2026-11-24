// The witness `orca_home_shows_the_persons_in_force_state`. Given API answers holding the
// person's resume, newest session handoff, the three ways in, their places and the recently
// updated, Home shows exactly the lists temper-ui's home reads for the same person — every list
// with its omission sentence and its order, the handoff beside them with its Next section
// quoted. It bites against the #103 context-scoped panel: its requests answer only the
// person-scoped names, so anything still asking the retired context-scoped reads finds nothing.
// It reads the panel alone: the request answers are fixture data, typed here rather than
// imported, so this one file stands on its own.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

function item(
  suffix: string,
  title: string,
  docType: string,
  contextRef: string | null = '+temper-dev/contrib',
  stage: string | null = null
) {
  return {
    id: `00000000-0000-7000-8000-0000000000${suffix}`,
    ref: `row-00000000-0000-7000-8000-0000000000${suffix}`,
    title,
    docType,
    contextRef,
    updated: '2026-11-20T01:00:00Z',
    stage
  }
}

const WAY_IN_WORDS: Record<string, { label: string; scope: string }> = {
  goals: { label: 'goals', scope: 'active goals of yours' },
  tasks: { label: 'in progress', scope: 'tasks in progress of yours' },
  sessions: { label: 'sessions', scope: 'sessions of yours' }
}
const WAY_DOC_TYPES: Record<string, string> = { goals: 'goal', tasks: 'task', sessions: 'session' }

/** A way-in answer grown to the asked bound: `total` rows exist, `bound` of them answer. */
function wayInAnswer(id: string, titles: string[], total: number, bound: number) {
  const words = WAY_IN_WORDS[id] ?? { label: id, scope: id }
  return {
    state: 'ok' as const,
    id,
    label: words.label,
    scope: words.scope,
    rows: titles.slice(0, bound).map((title, index) => item(`${id.slice(0, 1)}${index}`, title, WAY_DOC_TYPES[id] ?? id)),
    total,
    bound
  }
}

test('orca_home_shows_the_persons_in_force_state', async () => {
  const host = mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: ['settings:own'] }),
      'temper.home.resume': () => ({
        state: 'ok',
        resume: {
          resource: item('r1', 'The design record', 'decision'),
          changedAt: '2026-11-20T02:00:00Z'
        }
      }),
      'temper.home.handoff': () => ({
        state: 'ok',
        sessionCount: 4,
        handoff: {
          id: '00000000-0000-7000-8000-0000000000d4',
          ref: 'handoff-note-00000000-0000-7000-8000-0000000000d4',
          title: 'The latest session note',
          contextRef: '+temper-dev/contrib',
          next: {
            heading: 'Next steps',
            text: '- Record the witness runs\n- Run the live check',
            truncated: false
          }
        }
      }),
      'temper.home.way-in': (input: { id: string; bound: number }) => {
        const titles = {
          goals: ['Goal one', 'Goal two'],
          tasks: ['Task in progress one'],
          sessions: ['The latest session note']
        }[input.id] ?? []
        return wayInAnswer(input.id, titles, titles.length, input.bound)
      },
      'temper.home.places': () => ({
        state: 'ok',
        rows: [
          { id: '11111111-1111-7111-8111-111111111111', ref: '+temper-dev/contrib-workflows', name: 'contrib-workflows', lastChangedAt: '2026-11-20T03:00:00Z' }
        ],
        total: 1
      }),
      'temper.home.recent': () => ({
        state: 'ok',
        rows: [
          item('e1', 'A task', 'task', '+temper-dev/contrib-workflows'),
          item('e2', 'A goal', 'goal', '+temper-dev/contrib')
        ],
        total: 2
      })
    }
  })
  mounted = await mount(panel, { host })

  // Resume: the one resource the person last changed, named as theirs.
  assert.ok(mounted.find({ text: 'resume' }), 'the resume region is on the panel')
  assert.ok(mounted.find({ label: 'The design record' }), 'the resource they changed is on the panel')
  assert.ok(mounted.find({ text: 'the one resource you last changed' }), 'resume says what it is')

  // The latest handoff, beside the lists: the session, and its Next section quoted as written.
  assert.ok(
    mounted.find({ type: 'Card', label: 'latest handoff' }),
    'the handoff is a card, named as both surfaces name it'
  )
  assert.ok(mounted.find({ label: 'The latest session note' }), 'the newest session is on the panel')
  assert.ok(mounted.find({ text: 'excerpt · Next steps' }), 'the excerpt names its section')
  assert.ok(
    mounted.find({ text: '- Record the witness runs\n- Run the live check' }),
    'the Next section renders as plain text, verbatim'
  )
  assert.ok(
    mounted.find({ text: '1 of 4 sessions of yours; 3 not shown.' }),
    'the handoff says what it stands before'
  )

  // The ways in, under their shared names, each counted and ordered, each saying what it omits.
  assert.ok(mounted.find({ type: 'Heading', text: 'goals 2' }), 'the goals way-in is counted')
  assert.ok(mounted.find({ label: 'Goal one' }), 'Goal one is on the panel')
  assert.ok(mounted.find({ text: 'All 2 active goals of yours.' }), 'the goals omission sentence is on the panel')
  assert.ok(mounted.find({ type: 'Heading', text: 'tasks 1' }), 'the tasks way-in is counted, in progress by default')
  assert.ok(mounted.find({ label: 'Task in progress one' }), 'the task is on the panel')
  assert.ok(mounted.find({ text: 'All 1 tasks in progress of yours.' }), 'the tasks omission sentence is on the panel')
  assert.ok(mounted.find({ type: 'Heading', text: 'sessions 1' }), 'the sessions way-in is counted')
  assert.ok(mounted.find({ text: 'All 1 sessions of yours.' }), 'the sessions omission sentence is on the panel')
  const orderNotes = mounted.findAll({ text: 'most recently updated first' })
  assert.ok(orderNotes.length >= 4, 'every updated-ordered list states its order')

  // Places: the contexts the person changed something in, ordered by their own latest change.
  assert.ok(mounted.find({ type: 'Heading', text: 'places 1' }), 'the places region is counted')
  assert.ok(mounted.find({ label: 'contrib-workflows' }), 'the place is on the panel')
  assert.ok(mounted.find({ text: 'by your latest change in each' }), 'the places order is stated')
  assert.ok(mounted.find({ text: 'All 1 places you changed something in.' }), 'the places omission sentence is on the panel')

  // Recently updated: across everything readable, and it says so.
  assert.ok(mounted.find({ type: 'Heading', text: 'recently updated 2' }), 'recently updated is counted')
  assert.ok(mounted.find({ label: 'A task' }), 'a recent row is on the panel')
  assert.ok(mounted.find({ text: 'All 2 resources you can read.' }), 'recently updated says what it covers')

  // Nothing from the retired context-scoped panel: no contexts sentence, no refusal, no extras.
  assert.equal(mounted.find({ type: 'EmptyState' }), null, 'no refusal shows while every region is served')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('Show more grows a way in in place, and stops at the cap', async () => {
  const seenBounds: number[] = []
  const titles = Array.from({ length: 250 }, (_, index) => `Goal ${index + 1}`)
  const host = mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: ['settings:own'] }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => ({ state: 'ok', sessionCount: 0, handoff: null }),
      'temper.home.way-in': (input: { id: string; bound: number }) => {
        seenBounds.push(input.bound)
        return input.id === 'goals'
          ? wayInAnswer('goals', titles, 250, input.bound)
          : wayInAnswer(input.id, [], 0, input.bound)
      },
      'temper.home.places': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 })
    }
  })
  mounted = await mount(panel, { host })

  // The default bound, and the sentence saying what it omits.
  assert.ok(mounted.find({ type: 'Heading', text: 'goals 250' }), 'the goals way-in is counted against the total')
  assert.ok(mounted.find({ text: '8 of 250 active goals of yours; 242 not shown.' }), 'the omission sentence is on the panel')
  assert.ok(mounted.find({ text: 'Show more' }), 'Show more is offered')
  assert.ok(mounted.find({ label: 'Goal 8' }), 'the eighth row is on the panel')
  assert.equal(mounted.find({ label: 'Goal 9' }), null, 'the ninth row waits')

  // One press grows the one list in place by the shared step.
  await mounted.press({ text: 'Show more' })
  assert.equal(seenBounds[seenBounds.length - 1], 16, 'the press asked for one step more')
  assert.ok(mounted.find({ label: 'Goal 16' }), 'the grown list shows the new rows')
  assert.ok(mounted.find({ text: '16 of 250 active goals of yours; 234 not shown.' }), 'the omission sentence grew with it')
  assert.ok(mounted.find({ type: 'Heading', text: 'tasks 0' }), 'the other way in was left as it was')

  // Grown to the cap, Show more stops being offered — past it is never this panel's read.
  seenBounds.length = 0
  for (let press = 16; press < 200; press += 8) {
    await mounted.press({ text: 'Show more' })
  }
  assert.equal(seenBounds[seenBounds.length - 1], 200, 'the last press asked at the cap, no further')
  assert.ok(mounted.find({ label: 'Goal 200' }), 'the cap row is on the panel')
  assert.ok(mounted.find({ text: '200 of 250 active goals of yours; 50 not shown.' }), 'the sentence says what lies past the cap')
  assert.equal(mounted.find({ text: 'Show more' }), null, 'Show more stops at the cap')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('a way in that fails while Show more presses keeps its failure, not its rows', async () => {
  let serve = true
  const host = mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: ['settings:own'] }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => ({ state: 'ok', sessionCount: 0, handoff: null }),
      'temper.home.way-in': (input: { id: string; bound: number }) => {
        if (!serve && input.id === 'goals') {
          return { state: 'failed', message: 'temper refused the active goals of yours read' }
        }
        return wayInAnswer(input.id, input.id === 'goals' ? ['Goal one'] : [], input.id === 'goals' ? 12 : 0, input.bound)
      },
      'temper.home.places': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 })
    }
  })
  mounted = await mount(panel, { host })
  assert.ok(mounted.find({ label: 'Goal one' }))

  serve = false
  await mounted.press({ text: 'Show more' })
  assert.ok(
    mounted.find({ type: 'Callout', label: 'goals unavailable — nothing here was read.' }),
    'the failing growth names what failed'
  )
  assert.ok(mounted.find({ type: 'Heading', text: 'tasks 0' }), 'the other way in is untouched')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('Home wears the look: counts as badges, doc-type icons, row states in words, Show more small', async () => {
  const host = mockHost({
    requests: {
      'temper.capabilities': () => ({ granted: ['settings:own'] }),
      'temper.home.resume': () => ({
        state: 'ok',
        resume: {
          resource: item('r1', 'The task I changed', 'task', '+temper-dev/contrib', 'in-progress'),
          changedAt: '2026-11-20T02:00:00Z'
        }
      }),
      'temper.home.handoff': () => ({ state: 'ok', sessionCount: 0, handoff: null }),
      'temper.home.way-in': (input: { id: string; bound: number }) =>
        input.id === 'goals'
          ? wayInAnswer('goals', Array.from({ length: 12 }, (_, i) => `Goal ${i + 1}`), 12, input.bound)
          : wayInAnswer(input.id, [], 0, input.bound),
      'temper.home.places': () => ({
        state: 'ok',
        rows: [{ id: '33333333-3333-7333-8333-333333333333', ref: '+temper-dev/contrib', name: 'contrib', lastChangedAt: '2026-11-20T03:00:00Z' }],
        total: 1
      }),
      'temper.home.recent': () => ({
        state: 'ok',
        rows: [item('e1', 'A recent task', 'task', '+temper-dev/contrib', 'backlog')],
        total: 1
      })
    }
  })
  mounted = await mount(panel, { host })

  const heading = mounted.find({ type: 'Heading', text: 'goals 12' })
  assert.notEqual(heading, null, 'the count rides the heading')
  const badge = mounted.find({ type: 'Badge', text: '12' })
  assert.ok(badge && heading && badge.path.startsWith(heading.path), 'as a badge in it')

  const resume = mounted.find({ type: 'ListItem', label: 'The task I changed' })
  assert.equal(resume?.props.icon, 'hammer')
  assert.equal(resume?.props.description, 'task · in progress', 'the stage is words, not a row badge')
  const goal = mounted.find({ type: 'ListItem', label: 'Goal 1' })
  assert.equal(goal?.props.icon, 'flag')
  assert.equal(goal?.props.description, 'goal', 'a way in names no state its heading already says')
  const recent = mounted.find({ type: 'ListItem', label: 'A recent task' })
  assert.equal(recent?.props.description, 'task · backlog · +temper-dev/contrib')
  assert.equal(mounted.find({ type: 'ListItem', label: 'contrib' })?.props.icon, 'folder')
  for (const row of mounted.findAll({ type: 'ListItem' })) {
    assert.equal(mounted.findAll({ type: 'Badge' }).some((b) => b.path.startsWith(row.path)), false, 'no row carries a badge')
  }

  const more = mounted.find({ type: 'Button', text: 'Show more' })
  assert.equal(more?.props.variant, 'ghost')
  assert.equal(more?.props.size, 'sm')
  assert.equal(more?.props.icon, 'expand')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.warnings, [])
})
