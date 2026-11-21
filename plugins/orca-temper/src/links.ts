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
      ...(typeof row['sessionId'] === 'string' ? { sessionId: row['sessionId'] } : {})
    })
  }
  return links
}

export async function writeLinks(orca: OrcaWorkerApi, links: readonly LaunchLink[]): Promise<void> {
  await orca.storage.set(
    LAUNCH_LINKS_KEY,
    links.map((link) => ({ ...link }))
  )
}

/** Stores one launch's link, replacing the same workspace × item pair. */
export async function storeLink(orca: OrcaWorkerApi, link: LaunchLink): Promise<void> {
  const links = await readLinks(orca)
  await writeLinks(orca, [
    ...links.filter(
      (entry) => !(entry.workspaceId === link.workspaceId && entry.itemId === link.itemId)
    ),
    link
  ])
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
  const links = await readLinks(orca)
  const kept = links.filter((link) => !gone.includes(link.workspaceId))
  if (kept.length !== links.length) {
    await writeLinks(orca, kept)
  }
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
  const links = await readLinks(orca)
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
  if (changed) {
    await writeLinks(orca, next)
  }
}

/**
 * The workspaces one item is linked to, named as `workspace.list` gives them, each with the
 * session its link carries. Links whose session is still unknown ask `agents.list` for their
 * workspace and take the session of the launch's own terminal when Orca names one. A link
 * whose workspace a complete `workspace.list` no longer has is dropped from storage; with a
 * truncated list, a link not found is left stored but not offered (it cannot be named).
 */
export async function linkedWorkspaces(
  orca: OrcaWorkerApi,
  itemId: string
): Promise<LinkedWorkspace[]> {
  const links = await readLinks(orca)
  const listed = await orca.host.call('workspace.list')
  const byId = new Map(listed.workspaces.map((workspace) => [workspace.id, workspace]))

  let changed = false
  const kept: LaunchLink[] = []
  for (const link of links) {
    if (!byId.has(link.workspaceId) && listed.truncated !== true) {
      changed = true
      continue
    }
    kept.push(link)
  }

  const answer: LinkedWorkspace[] = []
  for (let index = 0; index < kept.length; index += 1) {
    const link = kept[index]
    if (link === undefined || link.itemId !== itemId) {
      continue
    }
    const workspace = byId.get(link.workspaceId)
    if (workspace === undefined) {
      continue
    }
    let sessionId = link.sessionId ?? null
    if (sessionId === null && typeof link.terminalId === 'string' && orca.host.has('agents.list')) {
      const learned = await sessionFromAgentsList(orca, link)
      if (learned !== null) {
        sessionId = learned
        kept[index] = { ...link, sessionId }
        changed = true
      }
    }
    answer.push({
      workspaceId: link.workspaceId,
      name: workspace.name,
      agent: link.agent ?? null,
      sessionId
    })
  }
  if (changed) {
    await writeLinks(orca, kept)
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
