// The first prompts (design record, Rulings Q4/Q4a): harness-agnostic text that names the
// temper skill and the CLI, the full ref and context, the bare-id read, and the fallback —
// and, for a task start or resume, the latest handoff's Next section quoted as written. The
// goal prompt is Q4a's wording verbatim but with the refs filled.
import { assert, test } from 'orca/testing'
import {
  goalWorkPrompt,
  handoffResumePrompt,
  taskResumePrompt,
  taskStartPrompt,
  type PromptItem
} from './prompts'

const ITEM: PromptItem = {
  id: '00000000-0000-7000-8000-0000000000d1',
  ref: 'the-task-00000000-0000-7000-8000-0000000000d1',
  title: 'The item',
  contextRef: '+temper-dev/contrib-workflows'
}

const NEXT = { heading: 'Next steps', text: '- Record the witness runs', truncated: false }

test('task start names the skill, the ref, the context, the read and the fallback', () => {
  const prompt = taskStartPrompt(ITEM, null)
  assert.ok(prompt.startsWith('You are starting work on a temper task.'), 'the draft leads')
  assert.ok(prompt.includes('Use the temper skill with the `temper` CLI if you have it.'))
  assert.ok(prompt.includes(`Start the task: ref \`${ITEM.ref}\`, in context \`${ITEM.contextRef}\`.`))
  assert.ok(prompt.includes(`temper resource show ${ITEM.id} --format json`))
  assert.ok(prompt.includes('"How to hold this item" section'))
  assert.ok(prompt.includes('temper skill check'), 'the fallback rides')
  assert.ok(!prompt.includes('/temper'), 'never a slash command')
  assert.ok(!prompt.includes('Next steps'), 'no handoff is invented')
})

test('the handoff Next section is quoted as written when one was read', () => {
  const prompt = taskStartPrompt(ITEM, NEXT)
  assert.ok(prompt.includes('- Record the witness runs'), 'the Next text rides verbatim')
  assert.ok(prompt.indexOf('Next section') < prompt.indexOf('- Record the witness runs'), 'it is introduced before quoted')
})

test('task resume asks for the task-resume flow from the latest session', () => {
  const prompt = taskResumePrompt(ITEM, NEXT)
  assert.ok(prompt.includes('You are resuming work on a temper task.'))
  assert.ok(prompt.includes(`Resume the task: ref \`${ITEM.ref}\``))
  assert.ok(prompt.includes('task-resume flow'))
  assert.ok(prompt.includes('- Record the witness runs'))
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
