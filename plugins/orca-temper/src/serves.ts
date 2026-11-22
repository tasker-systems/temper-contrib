// What a workspace serves, worker side: the launch hook that tells an agent its task, and the
// read behind Home's "this workspace" strip. Both read the workspace ↔ item link a launch
// stored in the plugin's own storage (./links.ts); neither writes to temper.
//
// The hook. `agent.launch.before` runs for every agent Orca starts, from any launcher. When the
// workspace it starts in is linked to a temper task, the agent's environment gains
// `TEMPER_TASK` (the task's ref) and `TEMPER_CONTEXT` (its context's ref); in a workspace with
// no link, or a link to anything but a task, it gains nothing — an agent is never told it
// serves what the link cannot vouch for. Hooks get 2 s and no network, so the hook reads
// storage only, and a storage refusal adds nothing. The first prompts stay as ruled; the env
// is an addition beside them.
//
// Two facts of Orca's (1.4.269, read from its shipped bundle) shape the match:
// - The hook's `workspaceId` is Orca's own worktree id, `<projectId>::<path>`, not the id
//   `workspace.create` and `workspace.list` give (`identity:…`). So a link keeps its
//   workspace's project and path (from `workspace.list`), and the hook matches either form.
// - `workspace.create` starts its agent before it returns, so the hook for a Start press can
//   run before the launch has stored its link — and a host call the hook makes then can wait
//   behind that create past the hook's 2 s. So the launch registers itself as pending first,
//   and the hook answers from a pending launch whose project and agent are the ones starting,
//   in memory and before any host call — only when exactly one item is pending there, never a
//   guess between two. Otherwise it reads the stored links.
//
// The strip's read. `temper.serves` names the stored link for the focused workspace and reads
// the item's record on the grant (its own region state: a signed-out or failed read leaves the
// link standing, named by its stored title and ref). A link stored before it carried a doc
// type, title, project or path learns them here — from the record read and `workspace.list` —
// so an older link is hook-ready once its workspace has been shown.
import type { OrcaWorkerApi } from 'orca/worker'
import type { Gate } from './editor-room/open-body'
import { readLinks, writeLinks } from './links'
import type { LaunchLink, RecordDetailOutput, ServesInput, ServesOutput } from './protocol'
import { resourceDetail } from './reads'

export const TASK_ENV = 'TEMPER_TASK'
export const CONTEXT_ENV = 'TEMPER_CONTEXT'

/** The link, less the workspace it will be stored against — what a pending launch knows. */
export type PendingLink = Omit<LaunchLink, 'workspaceId'>

/** A launch sent to `workspace.create` whose link is not stored yet. */
export interface PendingLaunch {
  projectId: string
  agent: string
  link: PendingLink
}

/** The hook event's fields the match reads. */
export interface LaunchEvent {
  agent: string
  workspaceId: string | null
}

/** Orca's own worktree id for a linked workspace, when the link carries its project and path. */
export function worktreeIdOf(link: Pick<LaunchLink, 'projectId' | 'path'>): string | null {
  return typeof link.projectId === 'string' && typeof link.path === 'string'
    ? `${link.projectId}::${link.path}`
    : null
}

/** Whether a link is to the workspace an id names, in either of Orca's id forms. */
export function linkIsFor(link: LaunchLink, workspaceId: string): boolean {
  return link.workspaceId === workspaceId || worktreeIdOf(link) === workspaceId
}

/** The newest link to a workspace, or null when none joins it to an item. */
export function servingLink(links: readonly LaunchLink[], workspaceId: string): LaunchLink | null {
  let newest: LaunchLink | null = null
  for (const link of links) {
    if (linkIsFor(link, workspaceId) && (newest === null || link.startedAt > newest.startedAt)) {
      newest = link
    }
  }
  return newest
}

/** The one pending launch starting in this workspace's project with this agent, or null. */
export function pendingFor(
  pending: Iterable<PendingLaunch>,
  event: LaunchEvent
): PendingLink | null {
  const workspaceId = event.workspaceId
  if (workspaceId === null) {
    return null
  }
  const here = [...pending].filter(
    (launch) => launch.agent === event.agent && workspaceId.startsWith(`${launch.projectId}::`)
  )
  const items = new Set(here.map((launch) => launch.link.itemId))
  return items.size === 1 ? (here[0]?.link ?? null) : null
}

/** What a link tells an agent: its task and context, only for a link to a task. */
export function taskEnv(link: Pick<LaunchLink, 'docType' | 'ref' | 'itemId' | 'contextRef'>): Record<string, string> {
  if (link.docType !== 'task') {
    return {}
  }
  const task = link.ref !== '' ? link.ref : link.itemId
  return {
    [TASK_ENV]: task,
    ...(link.contextRef !== null && link.contextRef !== '' ? { [CONTEXT_ENV]: link.contextRef } : {})
  }
}

/** The env the hook adds for one launch from the stored links. */
export function storedEnv(links: readonly LaunchLink[], event: LaunchEvent): Record<string, string> {
  if (event.workspaceId === null) {
    return {}
  }
  const link = servingLink(links, event.workspaceId)
  return link === null ? {} : taskEnv(link)
}

/** The launches this worker has sent and not yet linked; the hook reads it, the launch fills it. */
export function createPendingLaunches(): Set<PendingLaunch> {
  return new Set()
}

export function registerServes(orca: OrcaWorkerApi, gate: Gate, pending: Set<PendingLaunch>): void {
  orca.hooks.on('agent.launch.before', async (event, next) => {
    if (event.workspaceId === null) {
      return next(event)
    }
    const starting = pendingFor(pending, event)
    let env: Record<string, string>
    if (starting !== null) {
      env = taskEnv(starting)
    } else {
      try {
        env = storedEnv(await readLinks(orca), event)
      } catch {
        env = {}
      }
    }
    if (Object.keys(env).length === 0) {
      return next(event)
    }
    return next({ ...event, env: { ...event.env, ...env } })
  })

  orca.panels.handle('temper.serves', (input: ServesInput) => serves(orca, gate, input))
}

async function serves(orca: OrcaWorkerApi, gate: Gate, input: ServesInput): Promise<ServesOutput> {
  if (typeof input?.workspaceId !== 'string' || input.workspaceId.trim() === '') {
    return { state: 'failed', message: 'no workspace was named' }
  }
  let link: LaunchLink | null
  try {
    link = servingLink(await readLinks(orca), input.workspaceId)
  } catch (error) {
    return {
      state: 'failed',
      message: `the stored links could not be read: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (link === null) {
    return { state: 'unlinked' }
  }
  const served = link
  const record: RecordDetailOutput = await gate(async (read) => ({
    state: 'ok' as const,
    detail: await resourceDetail(read, served.itemId)
  }))
  const learned = await learnLink(orca, served, record)
  return {
    state: 'linked',
    item: {
      itemId: learned.itemId,
      ref: learned.ref,
      title: learned.title ?? null,
      docType: learned.docType ?? null,
      contextRef: learned.contextRef
    },
    record
  }
}

/**
 * Fills what an older link lacks — its doc type and title from the record read, its project
 * and path from `workspace.list` — and stores it. Best effort: a refused list or write leaves
 * the link as it was, and the strip still answers.
 */
async function learnLink(orca: OrcaWorkerApi, link: LaunchLink, record: RecordDetailOutput): Promise<LaunchLink> {
  const patch: Partial<LaunchLink> = {}
  if (record.state === 'ok') {
    if (link.docType !== record.detail.docType) {
      patch.docType = record.detail.docType
    }
    if (link.title !== record.detail.title) {
      patch.title = record.detail.title
    }
  }
  if (worktreeIdOf(link) === null) {
    try {
      const listed = await orca.host.call('workspace.list')
      const row = listed.workspaces.find((workspace) => workspace.id === link.workspaceId)
      if (row !== undefined && typeof row.projectId === 'string' && row.projectId !== '') {
        patch.projectId = row.projectId
        patch.path = row.path
      }
    } catch {
      // Without the list, the hook still matches the link by the id `workspace.list` gives.
    }
  }
  if (Object.keys(patch).length === 0) {
    return link
  }
  try {
    const links = await readLinks(orca)
    await writeLinks(
      orca,
      links.map((entry) =>
        entry.workspaceId === link.workspaceId && entry.itemId === link.itemId ? { ...entry, ...patch } : entry
      )
    )
  } catch {
    // The answer stands without the stored lesson; the next read tries again.
  }
  return { ...link, ...patch }
}
