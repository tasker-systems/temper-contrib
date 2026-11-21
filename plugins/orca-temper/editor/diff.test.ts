// The line difference the tab shows: empty for the same text, every added and removed line
// otherwise, and a line ending change is not a change.
import { assert, test } from 'orca/testing'
import { changeWords, diffLines } from './diff'

test('the same text has no difference', () => {
  const diff = diffLines('a\nb\n', 'a\nb\n')
  assert.equal(changeWords(diff), 'No changes from the base')
  assert.deepEqual(diff.lines.map((line) => line.kind), ['same', 'same'])
})

test('a CRLF copy of the base is not a change', () => {
  assert.equal(changeWords(diffLines('a\nb\n', 'a\r\nb\r\n')), 'No changes from the base')
})

test('every added and removed line is in the difference, in order', () => {
  const diff = diffLines('one\ntwo\nthree\n', 'zero\none\nthree\nfour\n')
  assert.deepEqual(diff.lines, [
    { kind: 'added', text: 'zero' },
    { kind: 'same', text: 'one' },
    { kind: 'removed', text: 'two' },
    { kind: 'same', text: 'three' },
    { kind: 'added', text: 'four' }
  ])
  assert.equal(changeWords(diff), '2 lines added, 1 line removed since the base')
})

test('from or to an empty body', () => {
  assert.equal(changeWords(diffLines('', 'a\n')), '1 line added since the base')
  assert.equal(changeWords(diffLines('a\nb\n', '')), '2 lines removed since the base')
})
