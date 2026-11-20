// The witness `orca_panel_shows_the_in_force_state`. Given API responses holding active goals,
// in-progress tasks and session notes, the panel's answer holds all three groups — the latest
// note's Next steps section included — and nothing else. It bites against a panel that shows
// active goals only, and it reads the panel alone: the three request answers are fixture data,
// typed here rather than imported, so this one file stands on its own.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

type ResourceRow = { id: string; ref: string; title: string }

const GOALS_ANSWER: {
  connected: true
  contexts: string[]
  truncated: boolean
  goals: ResourceRow[]
} = {
  connected: true,
  contexts: ['+temper-dev/contrib'],
  truncated: false,
  goals: [
    { id: '00000000-0000-7000-8000-0000000000a1', ref: 'goal-one-00000000-0000-7000-8000-0000000000a1', title: 'Goal one' },
    { id: '00000000-0000-7000-8000-0000000000b2', ref: 'goal-two-00000000-0000-7000-8000-0000000000b2', title: 'Goal two' }
  ]
}
const TASKS_ANSWER: {
  connected: true
  contexts: string[]
  truncated: boolean
  tasks: ResourceRow[]
} = {
  connected: true,
  contexts: ['+temper-dev/contrib-workflows'],
  truncated: false,
  tasks: [
    { id: '00000000-0000-7000-8000-0000000000c3', ref: 'task-one-00000000-0000-7000-8000-0000000000c3', title: 'Task in progress one' }
  ]
}
const HANDOFF_ANSWER: {
  connected: true
  contexts: string[]
  truncated: boolean
  handoff: {
    id: string
    ref: string
    title: string
    contextRef: string
    nextSteps: string | null
  } | null
} = {
  connected: true,
  contexts: ['+temper-dev/contrib-workflows'],
  truncated: false,
  handoff: {
    id: '00000000-0000-7000-8000-0000000000d4',
    ref: 'handoff-note-00000000-0000-7000-8000-0000000000d4',
    title: 'The latest session note',
    contextRef: '+temper-dev/contrib-workflows',
    nextSteps: '- Record the witness runs\n- Run the live check\n- Land on main'
  }
}

test('orca_panel_shows_the_in_force_state', async () => {
  const host = mockHost({
    requests: {
      'temper.goals.active': () => GOALS_ANSWER,
      'temper.tasks.in-progress': () => TASKS_ANSWER,
      'temper.handoff.latest': () => HANDOFF_ANSWER
    }
  })
  mounted = await mount(panel, { host })

  // The goals group, with its count.
  assert.ok(mounted.find({ text: 'Active goals (2)' }), 'the active goals are counted on the panel')
  assert.ok(mounted.find({ label: 'Goal one' }), 'Goal one is on the panel')
  assert.ok(mounted.find({ label: 'Goal two' }), 'Goal two is on the panel')

  // The tasks group, with its count.
  assert.ok(mounted.find({ text: 'Tasks in progress (1)' }), 'the tasks in progress are counted on the panel')
  assert.ok(mounted.find({ label: 'Task in progress one' }), 'Task in progress one is on the panel')

  // The handoff group: the latest note's Next steps, rendered as Markdown — the section, not
  // the note around it, and nothing else.
  assert.ok(mounted.find({ text: 'Latest handoff (1)' }), 'the latest handoff is counted on the panel')
  const markdown = mounted.find({ type: 'Markdown' })
  assert.notEqual(markdown, null, 'the handoff Next steps render as Markdown')
  assert.equal(
    markdown?.props.content,
    '- Record the witness runs\n- Run the live check\n- Land on main',
    'the Markdown carries the Next steps section, verbatim'
  )
  assert.equal(mounted.find({ label: 'The latest session note' }), null, 'the note title is not a list row')

  // Nothing else: no refusal, no invented state, no extra items.
  assert.equal(mounted.find({ type: 'EmptyState' }), null, 'no refusal shows while every group is served')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})
