// The `launch-links` key has several writers in one worker: a launch storing its link, the
// session learner on `agent.status.changed`, the sheet's linked-workspaces read, the strip's
// lesson, and `workspace.removed`. Each reads the array and writes it back. Pinned here: every
// one of those writes is one read-modify-write, run one at a time, so a writer that read before
// another wrote never puts back its stale copy; and a link a launch just stored is not dropped
// because a `workspace.list` does not name it yet, or names it in Orca's other id form.
import { assert, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  dropRemovedWorkspace,
  learnSessionFromEvent,
  linkedWorkspaces,
  readLinks,
  storeLink
} from './links'
import type { LaunchLink } from './protocol'

const ITEM = '00000000-0000-7000-8000-0000000000a1'
const OTHER = '00000000-0000-7000-8000-0000000000a2'
const LONG_AGO = '2026-11-01T00:00:00.000Z'

function link(overrides: Partial<LaunchLink> = {}): LaunchLink {
  return {
    workspaceId: 'identity:wt2:local:old',
    itemId: OTHER,
    ref: `the-old-task-${OTHER}`,
    contextRef: '+team/old',
    startedAt: LONG_AGO,
    terminalId: 't-old',
    ...overrides
  }
}

type ListRow = { id: string; name: string; projectId?: string; path: string }

/**
 * A worker's storage and host as Orca gives them, except that every storage read and write, and
 * every host call, yields to the event loop first — so two writers interleave as they can live.
 */
function fakeOrca(initial: LaunchLink[], list: () => ListRow[]) {
  let stored: unknown = structuredClone(initial)
  let writes = 0
  const yieldOnce = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  const orca = {
    storage: {
      get: async () => {
        await yieldOnce()
        return structuredClone(stored)
      },
      set: async (_key: string, value: unknown) => {
        await yieldOnce()
        stored = structuredClone(value)
        writes += 1
      }
    },
    host: {
      has: () => false,
      call: async (method: string) => {
        await yieldOnce()
        await yieldOnce()
        if (method === 'workspace.list') {
          return {
            workspaces: list().map((row) => ({ kind: 'worktree', branch: 'b', hostId: 'local', ...row })),
            truncated: false
          }
        }
        throw new Error(`unexpected host call ${method}`)
      }
    }
  } as unknown as OrcaWorkerApi
  return { orca, stored: () => stored as LaunchLink[], writes: () => writes }
}

const OLD_ROW: ListRow = { id: 'identity:wt2:local:old', name: 'old', projectId: 'repo-1', path: '/w/old' }

test("a launch's link survives a session learner that read the links before it was stored", async () => {
  const { orca, stored } = fakeOrca([link()], () => [OLD_ROW])
  const fresh = link({
    workspaceId: 'identity:wt2:local:new',
    itemId: ITEM,
    ref: `the-new-task-${ITEM}`,
    contextRef: '+team/new',
    startedAt: new Date().toISOString(),
    terminalId: 't-new'
  })

  await Promise.all([
    learnSessionFromEvent(orca, { workspaceId: 'repo-1::/w/old', workspaceListId: OLD_ROW.id, terminalId: 't-old', sessionId: 's-old' }),
    storeLink(orca, fresh)
  ])

  const links = stored()
  assert.equal(links.length, 2, 'both links are stored')
  assert.equal(links.find((entry) => entry.itemId === ITEM)?.contextRef, '+team/new', "the launch's link survived")
  assert.equal(links.find((entry) => entry.itemId === OTHER)?.sessionId, 's-old', "and the learner's session landed")
})

test("a launch's link survives the sheet's linked-workspaces read and a removal, run alongside it", async () => {
  let listed: ListRow[] = [OLD_ROW, { id: 'identity:wt2:local:gone', name: 'gone', projectId: 'repo-1', path: '/w/gone' }]
  const { orca, stored } = fakeOrca(
    [link(), link({ workspaceId: 'identity:wt2:local:gone', itemId: ITEM, ref: 'gone', terminalId: 't-gone' })],
    () => listed
  )
  const fresh = link({ workspaceId: 'identity:wt2:local:new', itemId: ITEM, ref: 'fresh', startedAt: new Date().toISOString(), terminalId: 't-new' })
  listed = [OLD_ROW, { id: 'identity:wt2:local:new', name: 'new', projectId: 'repo-1', path: '/w/new' }]

  await Promise.all([
    linkedWorkspaces(orca, ITEM),
    storeLink(orca, fresh),
    dropRemovedWorkspace(orca, { workspaceId: 'repo-1::/w/other', workspaceListId: 'identity:wt2:local:other' }),
    learnSessionFromEvent(orca, { workspaceId: 'repo-1::/w/new', workspaceListId: 'identity:wt2:local:new', terminalId: 't-new', sessionId: 's-new' })
  ])

  const links = stored()
  const kept = links.map((entry) => entry.workspaceId).sort()
  assert.deepEqual(kept, ['identity:wt2:local:new', 'identity:wt2:local:old'], 'the removed workspace went, the new link stayed')
  assert.equal(links.find((entry) => entry.workspaceId === 'identity:wt2:local:new')?.sessionId, 's-new')
})

test('a link launched moments ago is kept although workspace.list does not name its workspace yet', async () => {
  const fresh = link({ workspaceId: 'identity:wt2:local:new', itemId: ITEM, ref: 'fresh', startedAt: new Date().toISOString() })
  const stale = link({ workspaceId: 'identity:wt2:local:long-gone', itemId: ITEM, ref: 'stale' })
  const { orca, stored } = fakeOrca([fresh, stale, link()], () => [OLD_ROW])

  const answer = await linkedWorkspaces(orca, ITEM)

  assert.deepEqual(answer, [], 'neither is offered: the list cannot name them')
  const kept = stored().map((entry) => entry.workspaceId).sort()
  assert.deepEqual(kept, ['identity:wt2:local:new', 'identity:wt2:local:old'], 'only the long-gone link was dropped')
})

test("a link stored under Orca's worktree id is matched to the listed workspace, not dropped", async () => {
  const raw = link({ workspaceId: 'repo-1::/w/new', itemId: ITEM, ref: 'raw', startedAt: LONG_AGO, terminalId: 't-raw' })
  const { orca, stored } = fakeOrca([raw], () => [{ id: 'identity:wt2:local:new', name: 'the-new-one', projectId: 'repo-1', path: '/w/new' }])

  const answer = await linkedWorkspaces(orca, ITEM)

  assert.deepEqual(answer, [{ workspaceId: 'identity:wt2:local:new', name: 'the-new-one', agent: null, sessionId: null }])
  const [only] = stored()
  assert.equal(only?.workspaceId, 'identity:wt2:local:new', 'the link now carries the listed id')
  assert.equal(only?.projectId, 'repo-1')
  assert.equal(only?.path, '/w/new')
  assert.equal((await readLinks(orca)).length, 1)
})
