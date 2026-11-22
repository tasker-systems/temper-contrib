// The workspace ↔ item links, worker side. A successful launch stores one (Rulings Q3: the
// write-back stays in the plugin's own storage, never temper). Decision ruling 23 gives the
// link two more jobs: the launcher sheet names an item's linked workspace before a second one
// is made, and Reopen agent resumes the agent session a link carries.
//
// The session is learned, never guessed: the launch stores the terminal `workspace.create`
// started the agent in, and the session id is taken only from Orca naming that same terminal —
// an `agent.status.changed` event (`sessionId`, host API 1.8) or an `agents.list` row for the
// linked workspace. A newer session in the same terminal replaces the older one. A link whose
// workspace is removed (`workspace.removed`, or absent from a complete `workspace.list`) is
// dropped, so nothing is ever offered against a workspace that is gone.
//
// Every write is one read-modify-write through `updateLinks`, and this worker runs them one at a
// time: the launch, the session learner, the sheet's read, the strip's lesson and a removal each
// read the array and write it back, and a writer that read before another wrote would otherwise
// put back its stale copy — dropping the link a launch had just stored. Host calls are made
// outside the queue; only the storage read and write are inside it.
//
// A list's silence is weak evidence. A workspace is matched by the id `workspace.list` gives it
// or by Orca's worktree id (`<project>::<path>`), the form a create can answer before the
// workspace has its identity key. A link younger than `LIST_ABSENCE_GRACE_MS` is never dropped
// for a list not naming it — `workspace.removed` still drops it at once.
import type { OrcaWorkerApi } from 'orca/worker'
import type { LaunchLink, LinkedWorkspace } from './protocol'
import { LAUNCH_LINKS_KEY } from './protocol'

/** The stored links, every malformed entry left out. */
export async function readLinks(orca: OrcaWorkerApi): Promise<LaunchLink[]> {
  const stored = await orca.storage.get(LAUNCH_LINKS_KEY)
  if (!Array.isArray(stored)) {
    return []
  }
  const links: LaunchLink[] = []
  for (const entry of stored) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue
    }
    const row = entry as Record<string, unknown>
    if (typeof row['workspaceId'] !== 'string' || typeof row['itemId'] !== 'string') {
      continue
    }
    links.push({
      workspaceId: row['workspaceId'],
      itemId: row['itemId'],
      ref: typeof row['ref'] === 'string' ? row['ref'] : '',
      contextRef: typeof row['contextRef'] === 'string' ? row['contextRef'] : null,
      startedAt: typeof row['startedAt'] === 'string' ? row['startedAt'] : '',
      ...(typeof row['agent'] === 'string' ? { agent: row['agent'] } : {}),
      ...(typeof row['terminalId'] === 'string' ? { terminalId: row['terminalId'] } : {}),
      ...(typeof row['sessionId'] === 'string' ? { sessionId: row['sessionId'] } : {}),
      ...(typeof row['title'] === 'string' ? { title: row['title'] } : {}),
      ...(typeof row['docType'] === 'string' && row['docType'] !== '' ? { docType: row['docType'] } : {}),
      ...(typeof row['projectId'] === 'string' && row['projectId'] !== '' ? { projectId: row['projectId'] } : {}),
      ...(typeof row['path'] === 'string' && row['path'] !== '' ? { path: row['path'] } : {})
    })
  }
  return links
}

/** How long a just-launched link is kept although a `workspace.list` does not name it. */
export const LIST_ABSENCE_GRACE_MS = 10 * 60 * 1000

/** The write queue per worker: each update starts when the one before it has settled. */
const queues = new WeakMap<object, Promise<unknown>>()

/**
 * Runs one read-modify-write of the links, after every update this worker queued before it.
 * `change` gets the links as stored now and answers the links to store, or null to write
 * nothing. A failed update rejects its caller and never stalls the ones after it.
 */
export function updateLinks(
  orca: OrcaWorkerApi,
  change: (links: LaunchLink[]) => LaunchLink[] | null
): Promise<void> {
  const before = queues.get(orca) ?? Promise.resolve()
  const run = before.then(
    () => applyUpdate(orca, change),
    () => applyUpdate(orca, change)
  )
  queues.set(
    orca,
    run.catch(() => undefined)
  )
  return run
}

async function applyUpdate(
  orca: OrcaWorkerApi,
  change: (links: LaunchLink[]) => LaunchLink[] | null
): Promise<void> {
  const next = change(await readLinks(orca))
  if (next !== null) {
    await orca.storage.set(
      LAUNCH_LINKS_KEY,
      next.map((link) => ({ ...link }))
    )
  }
}

/** Whether two entries are the same workspace × item pair. */
function samePair(a: Pick<LaunchLink, 'workspaceId' | 'itemId'>, b: Pick<LaunchLink, 'workspaceId' | 'itemId'>): boolean {
  return a.workspaceId === b.workspaceId && a.itemId === b.itemId
}

/** One entry per workspace × item pair, the newest kept, in stored order. */
function newestPerPair(links: readonly LaunchLink[]): LaunchLink[] {
  return links.filter(
    (link, index) =>
      !links.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          samePair(other, link) &&
          (other.startedAt > link.startedAt || (other.startedAt === link.startedAt && otherIndex > index))
      )
  )
}

/** Stores one launch's link, replacing the same workspace × item pair. */
export function storeLink(orca: OrcaWorkerApi, link: LaunchLink): Promise<void> {
  return updateLinks(orca, (links) => [...links.filter((entry) => !samePair(entry, link)), link])
}

/** Merges fields into one stored pair, if it is still stored; nothing else is touched. */
export function patchLink(
  orca: OrcaWorkerApi,
  pair: Pick<LaunchLink, 'workspaceId' | 'itemId'>,
  patch: Partial<LaunchLink>
): Promise<void> {
  return updateLinks(orca, (links) =>
    links.some((entry) => samePair(entry, pair))
      ? links.map((entry) => (samePair(entry, pair) ? { ...entry, ...patch } : entry))
      : null
  )
}

/** The ids Orca may use for one workspace in an event: the listed id, then the raw one. */
function eventWorkspaceIds(payload: { workspaceId: string | null; workspaceListId?: string }): string[] {
  return [payload.workspaceListId, payload.workspaceId].filter(
    (id): id is string => typeof id === 'string' && id !== ''
  )
}

/** `workspace.removed`: every link to that workspace is dropped. */
export async function dropRemovedWorkspace(
  orca: OrcaWorkerApi,
  payload: { workspaceId: string; workspaceListId?: string }
): Promise<void> {
  const gone = eventWorkspaceIds(payload)
  await updateLinks(orca, (links) => {
    const kept = links.filter((link) => !gone.includes(link.workspaceId))
    return kept.length === links.length ? null : kept
  })
}

/**
 * `agent.status.changed`: when Orca names the session in a linked launch's own terminal, the
 * link carries it from then on. Any other terminal's session — even in the same workspace —
 * is not this launch's agent, and is not taken.
 */
export async function learnSessionFromEvent(
  orca: OrcaWorkerApi,
  payload: {
    workspaceId: string | null
    workspaceListId?: string
    terminalId?: string
    sessionId?: string
  }
): Promise<void> {
  const sessionId = payload.sessionId
  const terminalId = payload.terminalId
  if (typeof sessionId !== 'string' || sessionId === '' || typeof terminalId !== 'string') {
    return
  }
  const workspaces = eventWorkspaceIds(payload)
  await updateLinks(orca, (links) => {
    let changed = false
    const next = links.map((link) => {
      if (
        link.terminalId === terminalId &&
        workspaces.includes(link.workspaceId) &&
        link.sessionId !== sessionId
      ) {
        changed = true
        return { ...link, sessionId }
      }
      return link
    })
    return changed ? next : null
  })
}

/** A `workspace.list` row's fields the match reads. */
interface ListedWorkspace {
  id: string
  projectId?: string | null
  path: string
}

/** The listed workspace a link is to: by the listed id, or by Orca's worktree id either way. */
export function listedRowFor<Row extends ListedWorkspace>(
  rows: readonly Row[],
  link: Pick<LaunchLink, 'workspaceId' | 'projectId' | 'path'>
): Row | undefined {
  const own =
    typeof link.projectId === 'string' && typeof link.path === 'string' ? `${link.projectId}::${link.path}` : null
  return rows.find((row) => {
    if (row.id === link.workspaceId) {
      return true
    }
    const worktreeId = typeof row.projectId === 'string' && row.projectId !== '' ? `${row.projectId}::${row.path}` : null
    return worktreeId !== null && (worktreeId === link.workspaceId || worktreeId === own)
  })
}

/** Whether a link is old enough that a list not naming its workspace means the workspace is gone. */
function pastGrace(link: LaunchLink, now: number): boolean {
  const started = Date.parse(link.startedAt)
  return !Number.isFinite(started) || now - started > LIST_ABSENCE_GRACE_MS
}

/**
 * The workspaces one item is linked to, named as `workspace.list` gives them, each with the
 * session its link carries. Links whose session is still unknown ask `agents.list` for their
 * workspace and take the session of the launch's own terminal when Orca names one. A link
 * whose workspace a complete `workspace.list` no longer has, in either id form, is dropped from
 * storage once it is past the grace; a link named by its worktree id learns the listed id and
 * its project and path. With a truncated list, a link not found is left stored but not offered
 * (it cannot be named). The lessons are written through the queue against the links as stored
 * then, so a link stored meanwhile is never lost.
 */
export async function linkedWorkspaces(
  orca: OrcaWorkerApi,
  itemId: string
): Promise<LinkedWorkspace[]> {
  const links = await readLinks(orca)
  const listed = await orca.host.call('workspace.list')
  const now = Date.now()

  const gone: LaunchLink[] = []
  const lessons: { pair: LaunchLink; patch: Partial<LaunchLink> }[] = []
  const answer: LinkedWorkspace[] = []
  for (const link of links) {
    const workspace = listedRowFor(listed.workspaces, link)
    if (workspace === undefined) {
      if (listed.truncated !== true && pastGrace(link, now)) {
        gone.push(link)
      }
      continue
    }
    const patch: Partial<LaunchLink> = {}
    if (workspace.id !== link.workspaceId) {
      patch.workspaceId = workspace.id
    }
    if (typeof workspace.projectId === 'string' && workspace.projectId !== '' && link.path === undefined) {
      patch.projectId = workspace.projectId
      patch.path = workspace.path
    }
    if (link.itemId === itemId) {
      let sessionId = link.sessionId ?? null
      const named = { ...link, workspaceId: workspace.id }
      if (sessionId === null && typeof link.terminalId === 'string' && orca.host.has('agents.list')) {
        const learned = await sessionFromAgentsList(orca, named)
        if (learned !== null) {
          sessionId = learned
          patch.sessionId = learned
        }
      }
      answer.push({
        workspaceId: workspace.id,
        name: workspace.name,
        agent: link.agent ?? null,
        sessionId
      })
    }
    if (Object.keys(patch).length > 0) {
      lessons.push({ pair: link, patch })
    }
  }

  if (gone.length > 0 || lessons.length > 0) {
    await updateLinks(orca, (stored) => {
      let changed = false
      const next: LaunchLink[] = []
      for (const entry of stored) {
        if (gone.some((link) => samePair(link, entry) && link.startedAt === entry.startedAt)) {
          changed = true
          continue
        }
        const lesson = lessons.find((candidate) => samePair(candidate.pair, entry))
        if (lesson === undefined) {
          next.push(entry)
          continue
        }
        changed = true
        const patch = { ...lesson.patch }
        // A session the store learned meanwhile stands over this read's lesson.
        if (typeof entry.sessionId === 'string' && entry.sessionId !== '') {
          delete patch.sessionId
        }
        next.push({ ...entry, ...patch })
      }
      return changed ? newestPerPair(next) : null
    })
  }
  return answer
}

/** The session `agents.list` names in the launch's own terminal, or null — never another's. */
async function sessionFromAgentsList(orca: OrcaWorkerApi, link: LaunchLink): Promise<string | null> {
  try {
    const listed = await orca.host.call('agents.list', { workspaceId: link.workspaceId })
    const own = listed.agents.find((agent) => agent.terminalId === link.terminalId)
    return typeof own?.sessionId === 'string' && own.sessionId !== '' ? own.sessionId : null
  } catch {
    // No agent:read, or the workspace answered nothing: the session stays unknown.
    return null
  }
}
