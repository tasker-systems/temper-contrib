// Open body on a pushed detail: lit only by its three consents, one press asks the worker for
// exactly that record, and the answer stands under the button in its own words.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from '../panel'
import type { OpenBodyOutput } from './protocol'

let mounted: TestPanel | undefined
afterEach(() => mounted?.unmount())

const ID = '00000000-0000-7000-8000-0000000000f1'

function served(granted: string[], open: (input: { id: string }) => OpenBodyOutput) {
  const asked: string[] = []
  const host = mockHost({
    requests: {
      'temper.capabilities': () => ({ granted }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => ({ state: 'ok', sessionCount: 0, handoff: null }),
      'temper.home.way-in': () => ({ state: 'ok', id: 'goals', label: 'goals', scope: 'goals of yours', rows: [], total: 0, bound: 8 }),
      'temper.home.places': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.resource.detail': () => ({
        state: 'ok',
        detail: { id: ID, ref: `r-${ID}`, title: 'The body room', docType: 'task', stage: null, status: null, contextRef: null, properties: [] }
      }),
      'temper.body.open': (input: { id: string }) => {
        asked.push(input.id)
        return open(input)
      }
    }
  })
  return { host, asked }
}

const seeded = { persisted: { plugin: { 'detail-stack': [{ id: ID, ref: '', title: '', docType: 'task' }] } } }
const ALL = ['workspace:read', 'workspace:write', 'storage:own']

test('Open body asks the worker for this record and says where the tab opened', async () => {
  const { host, asked } = served(ALL, () => ({
    state: 'opened',
    path: `.temper-views/r-${ID}.temper.md`,
    workspace: 'linked',
    readAt: '2026-11-20T17:38:00.000Z'
  }))
  mounted = await mount(panel, { host, ...seeded })
  await mounted.settled()

  const button = mounted.findAll({ text: 'Open body' }).find((each) => each.role === 'button')
  assert.ok(button, 'the detail carries Open body')
  assert.equal(button.disabled, false)
  await mounted.press(button)
  assert.deepEqual(asked, [ID])
  assert.ok(mounted.find({ text: /Opened \.temper-views\/.* in an editor tab of linked — base read 2026-11-20T17:38/ }))
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('a refusal is shown in its own words', async () => {
  const { host } = served(ALL, () => ({ state: 'refused', message: 'No workspace is focused in Orca.' }))
  mounted = await mount(panel, { host, ...seeded })
  await mounted.settled()
  const button = mounted.findAll({ text: 'Open body' }).find((each) => each.role === 'button')
  assert.ok(button)
  await mounted.press(button)
  assert.ok(mounted.find({ text: '⚠ No workspace is focused in Orca.' }))
})

test('without its consents Open body is disabled and names what it needs', async () => {
  const { host, asked } = served(['workspace:read'], () => ({ state: 'refused', message: 'unreached' }))
  mounted = await mount(panel, { host, ...seeded })
  await mounted.settled()
  const button = mounted.findAll({ text: 'Open body' }).find((each) => each.role === 'button')
  assert.ok(button)
  assert.equal(button.disabled, true)
  // The two consents not granted, named in Orca's words, under the act row in warning text.
  const sentence = mounted.find({ text: /^Open body needs the 'Open and rename your workspaces.*' and 'Store data in the plugin's own storage folder' consents\.$/ })
  assert.ok(sentence)
  assert.equal(sentence.props.tone, 'warning')
  assert.deepEqual(asked, [])
})
