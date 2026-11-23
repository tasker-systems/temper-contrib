// The first prompts (design record, Rulings Q4/Q4a): harness-agnostic text that names the
// temper skill and the CLI, the full ref and context, the bare-id read, and the fallback —
// and, for a task start or resume, the latest handoff's Next section quoted as written. The
// goal prompt is Q4a's wording verbatim but with the refs filled.
import { assert, test } from 'orca/testing'
import {
  goalWorkPrompt,
  handoffBranch,
  handoffLabel,
  handoffPrompt,
  handoffResumePrompt,
  UNREAD_CHECK,
  type AdvancedTask,
  taskResumePrompt,
  taskStartPrompt,
  type PromptItem,
  type TaskHandoffInfo
} from './prompts'

const ITEM: PromptItem = {
  id: '00000000-0000-7000-8000-0000000000d1',
  ref: 'the-task-00000000-0000-7000-8000-0000000000d1',
  title: 'The item',
  contextRef: '+temper-dev/contrib-workflows'
}

const NEXT = { heading: 'Next steps', text: '- Record the witness runs', truncated: false }

/** The task's own latest session, linked by its `advances` edge. */
const TASK_HANDOFF: TaskHandoffInfo = {
  hasSession: true,
  session: {
    id: '00000000-0000-7000-8000-0000000000b1',
    ref: 'the-tasks-session-00000000-0000-7000-8000-0000000000b1',
    title: 'The task session'
  },
  next: NEXT
}

test('task start names the skill, the ref, the context, the read and the fallback', () => {
  const prompt = taskStartPrompt(ITEM, { hasSession: false, session: null, next: null })
  assert.ok(prompt.startsWith('You are starting work on a temper task.'), 'the draft leads')
  assert.ok(prompt.includes('Use the temper skill with the `temper` CLI if you have it.'))
  assert.ok(prompt.includes(`Start the task: ref \`${ITEM.ref}\`, in context \`${ITEM.contextRef}\`.`))
  assert.ok(prompt.includes(`temper resource show ${ITEM.id} --format json`))
  assert.ok(prompt.includes('"How to hold this item" section'))
  assert.ok(prompt.includes('temper skill check'), 'the fallback rides')
  assert.ok(!prompt.includes('/temper'), 'never a slash command')
})

test('a task with no linked session says it has no handoff yet and quotes nothing', () => {
  const prompt = taskStartPrompt(ITEM, { hasSession: false, session: null, next: null })
  assert.ok(prompt.includes('The task has no handoff yet'), 'the absence is said')
  assert.ok(!prompt.includes('Next section'), 'nothing is quoted or invented')
})

test('the task\'s own handoff Next section is quoted as written — never the person\'s latest', () => {
  const otherNext = { heading: 'Next steps', text: '- Someone else\'s leftovers', truncated: false }
  const prompt = taskStartPrompt(ITEM, { ...TASK_HANDOFF, next: otherNext })
  assert.ok(prompt.includes("- Someone else's leftovers"), 'the task\'s own session is quoted')
  assert.ok(prompt.includes('The task\'s latest handoff names what is next'), 'it is named as the task\'s own')
  assert.ok(!prompt.includes('- Record the witness runs'), 'another session\'s Next is not quoted')
})

test('a session without a Next heading says so and names the session', () => {
  const prompt = taskResumePrompt(ITEM, { ...TASK_HANDOFF, next: null })
  assert.ok(prompt.includes('carries no Next section'))
  assert.ok(prompt.includes(TASK_HANDOFF.session!.ref), 'the session\'s ref is named')
  assert.ok(prompt.includes(`temper resource show ${TASK_HANDOFF.session!.id}`))
})

test('a failed handoff read leaves the clause out rather than claiming', () => {
  const prompt = taskStartPrompt(ITEM, null)
  assert.ok(!prompt.includes('handoff'), 'no clause claims a handoff state')
  assert.ok(!prompt.includes('Next section'))
})

test('task resume asks for the task-resume flow from its latest session', () => {
  const prompt = taskResumePrompt(ITEM, TASK_HANDOFF)
  assert.ok(prompt.includes('You are resuming work on a temper task.'))
  assert.ok(prompt.includes(`Resume the task: ref \`${ITEM.ref}\``))
  assert.ok(prompt.includes('task-resume flow'))
  assert.ok(prompt.includes('- Record the witness runs'), 'the task\'s own Next is quoted')
})

test('the handoff resume names the session and starts from its Next section', () => {
  const session: PromptItem = { ...ITEM, ref: 'handoff-note-00000000-0000-7000-8000-0000000000d4' }
  const prompt = handoffResumePrompt(session, NEXT)
  assert.ok(prompt.includes(`session ref \`${session.ref}\`,`))
  assert.ok(prompt.includes('start from its Next section'))
  assert.ok(prompt.includes('- Record the witness runs'))
})

test('the goal prompt is the ruled wording, refs filled', () => {
  const goal: PromptItem = { ...ITEM, id: '00000000-0000-7000-8000-0000000000e1', ref: 'the-goal-00000000-0000-7000-8000-0000000000e1' }
  const prompt = goalWorkPrompt(goal)
  assert.equal(
    prompt,
    'You are taking up a temper goal. Use the temper skill with the `temper` CLI if you have it, following its working-a-goal guidance. ' +
      `Goal: ref \`${goal.ref}\`, context \`${goal.contextRef}\`. ` +
      'Read what is in force (the register, its current witnessed state, recent sessions and linked tasks), then propose the next chunk of work and the clause it advances. ' +
      'File nothing until the person agrees.'
  )
})

// The handoff card's branches (decision ruling 28): the prompt and label follow the stages of the
// tasks the session advanced, as the press read them.
const SESSION: PromptItem = {
  id: '00000000-0000-7000-8000-0000000000d4',
  ref: 'handoff-note-00000000-0000-7000-8000-0000000000d4',
  title: 'The latest session note',
  contextRef: '+temper-dev/contrib'
}

function advanced(n: number, stage: string | null): AdvancedTask {
  const id = `00000000-0000-7000-8000-0000000000c${n}`
  return { id, ref: `advanced-task-${id}`, title: `Advanced task ${n}`, contextRef: '+temper-dev/contrib-workflows', stage }
}

test('one in-progress task: Resume task, the task-resume prompt with this session as its handoff', () => {
  const task = advanced(1, 'in-progress')
  const branch = handoffBranch({ state: 'ok', tasks: [task] })
  assert.equal(branch.kind, 'resume-task')
  assert.equal(handoffLabel(branch), 'Resume task')
  const prompt = handoffPrompt(SESSION, NEXT, branch)
  assert.equal(prompt, taskResumePrompt(task, { hasSession: true, session: { id: SESSION.id, ref: SESSION.ref, title: SESSION.title }, next: NEXT }))
  assert.ok(prompt.includes(`Resume the task: ref \`${task.ref}\``))
  assert.ok(prompt.includes(NEXT.text), 'the session\'s Next rides as the task\'s handoff')
})

test('one done task: Continue from handoff, its Next read as follow-ups, nothing reopened or claimed', () => {
  const task = advanced(1, 'done')
  const branch = handoffBranch({ state: 'ok', tasks: [task] })
  assert.equal(branch.kind, 'follow-up')
  assert.equal(handoffLabel(branch), 'Continue from handoff')
  const prompt = handoffPrompt(SESSION, NEXT, branch)
  assert.ok(prompt.includes(`session ref \`${SESSION.ref}\``))
  assert.ok(prompt.includes(`The task this session advanced is done: ref \`${task.ref}\``))
  assert.ok(prompt.includes('Do not reopen it, and claim nothing — unless a follow-up is its own task'))
  assert.ok(prompt.includes('follow-ups to check against temper'))
  assert.ok(prompt.includes(`Its Next section, as written:\n${NEXT.text}`))
  assert.equal(prompt.includes('Resume the task'), false, 'never told to resume a closed task')
})

test('one cancelled task is named cancelled, not done', () => {
  const branch = handoffBranch({ state: 'ok', tasks: [advanced(1, 'cancelled')] })
  assert.equal(branch.kind, 'follow-up')
  const prompt = handoffPrompt(SESSION, null, branch)
  assert.ok(prompt.includes('is cancelled'))
  assert.equal(prompt.includes('is done'), false)
  assert.ok(prompt.includes('The session carries no Next section.'))
})

test('no task: the session-start prompt as it was', () => {
  const branch = handoffBranch({ state: 'ok', tasks: [] })
  assert.equal(branch.kind, 'no-task')
  assert.equal(handoffLabel(branch), 'Continue from handoff')
  assert.equal(handoffPrompt(SESSION, NEXT, branch), handoffResumePrompt(SESSION, NEXT))
})

test('several tasks: each named with its stage, the person asked which, none acted on', () => {
  const tasks = [advanced(1, 'in-progress'), advanced(2, 'done'), advanced(3, null)]
  const branch = handoffBranch({ state: 'ok', tasks })
  assert.equal(branch.kind, 'several')
  assert.equal(handoffLabel(branch), 'Continue from handoff', 'even with one of them in progress')
  const prompt = handoffPrompt(SESSION, NEXT, branch)
  assert.ok(prompt.includes('This session advanced 3 tasks'))
  assert.ok(prompt.includes(`- ref \`${tasks[0]!.ref}\` ("Advanced task 1"), in context \`+temper-dev/contrib-workflows\` — in progress`))
  assert.ok(prompt.includes(`- ref \`${tasks[1]!.ref}\` ("Advanced task 2"), in context \`+temper-dev/contrib-workflows\` — done`))
  assert.ok(prompt.includes(`- ref \`${tasks[2]!.ref}\` ("Advanced task 3"), in context \`+temper-dev/contrib-workflows\` — no stage`))
  assert.ok(prompt.includes('Ask the person which task to continue before you act on any of them'))
  assert.ok(prompt.includes('claim nothing until they say'))
})

test('a failed stage read falls back to the session start, with the line to check the task first', () => {
  const branch = handoffBranch({ state: 'failed', message: 'temper answered 503' })
  assert.equal(branch.kind, 'unread')
  assert.equal(handoffLabel(branch), 'Continue from handoff')
  const prompt = handoffPrompt(SESSION, NEXT, branch)
  assert.equal(prompt, handoffResumePrompt(SESSION, NEXT, UNREAD_CHECK))
  assert.ok(prompt.includes('could not be read from temper'))
  assert.ok(prompt.indexOf(UNREAD_CHECK) < prompt.indexOf(NEXT.text), 'the check comes before the Next')
})

test('one task in a stage no branch names: the session start, naming the task and its stage to check', () => {
  const task = advanced(1, 'backlog')
  const branch = handoffBranch({ state: 'ok', tasks: [task] })
  assert.equal(branch.kind, 'unnamed-stage')
  assert.equal(handoffLabel(branch), 'Continue from handoff')
  const prompt = handoffPrompt(SESSION, NEXT, branch)
  assert.ok(prompt.startsWith("You are starting a session from the person's latest temper handoff."))
  assert.ok(prompt.includes(`ref \`${task.ref}\``) && prompt.includes('temper holds its stage as backlog'))
})
