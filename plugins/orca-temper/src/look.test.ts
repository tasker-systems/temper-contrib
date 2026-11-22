// The rail's look on Orca's controls (./look.ts): the doc-type icon map, the state badge tones,
// the row words, and the detail's meta as the rail shows it.
import { assert, test } from 'orca/testing'
import { DOC_TYPE_ICON, docTypeIcon, formatTime, metaItems, PLACE_ICON, rowDescription, stateTone, stateWord } from './look'

test('each doc type wears its icon; any other takes the plain file', () => {
  assert.deepEqual(DOC_TYPE_ICON, {
    goal: 'flag',
    task: 'hammer',
    session: 'agent',
    decision: 'branch',
    research: 'lightbulb',
    concept: 'book',
    spec: 'file-text'
  })
  assert.equal(docTypeIcon('fact'), 'file')
  assert.equal(docTypeIcon(''), 'file')
  assert.equal(PLACE_ICON, 'folder')
})

test('a state badge is accent while worked, success when done, neutral otherwise', () => {
  assert.equal(stateTone('in-progress'), 'accent')
  assert.equal(stateTone('active'), 'accent')
  assert.equal(stateTone('done'), 'success')
  assert.equal(stateTone('completed'), 'success')
  assert.equal(stateTone('backlog'), 'neutral')
  assert.equal(stateTone('cancelled'), 'neutral')
  assert.equal(stateTone('something-new'), 'neutral')
  assert.equal(stateWord('in-progress'), 'in progress')
})

test('a row says its doc type, then its state in words', () => {
  assert.equal(rowDescription('task', 'in-progress'), 'task · in progress')
  assert.equal(rowDescription('goal', 'active'), 'goal · active')
  assert.equal(rowDescription('session', null), 'session')
  assert.equal(rowDescription('session', undefined), 'session')
})

test('the meta drops the doc_type row, formats updated and closes on the ref', () => {
  const items = metaItems({
    ref: 'a-ref',
    properties: [
      { label: 'doc_type', value: 'task' },
      { label: 'temper-stage', value: 'backlog' },
      { label: 'updated', value: '2026-11-20T01:05:00Z' }
    ]
  })
  assert.deepEqual(items, [
    { label: 'temper-stage', value: 'backlog' },
    { label: 'updated', value: '20 Nov 2026, 01:05 UTC' },
    { label: 'ref', value: 'a-ref', code: true }
  ])
  assert.equal(formatTime('not a time'), 'not a time', 'a value that is not a time shows as it came')
})
