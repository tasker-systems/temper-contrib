// The plugin's trusted worker. Every temper read goes: consult the ONE credential strategy this
// worker holds (its cache carries the refreshed token across panel reads; a read never mints a
// fresh token when a valid one is cached), then read through temper-ts at the origin temper
// auth status names (the API the CLI presents the minted grant to). Home's reads are
// temper-ui's home reads for the same person — the context-scoped lists and their settings are
// retired. Without the grant — at mint time or lost mid-read — the answer is a refusal, never a
// guess, and never partial or cached region data; the panel shows the refusal text. A read that
// fails any other way is that region's failure, beside the regions that answered.
import type { OrcaWorkerApi } from 'orca/worker'
import type { HostParams } from 'orca/host'
import { createCliCredentials, TemperNotConnectedError } from './credentials'
import { deps } from './deps'
import {
  GrantLostError,
  goalLinkedTasks,
  latestHandoff,
  placesInUse,
  recentlyUpdated,
  resourceDetail,
  resumeItem,
  sessionTasks,
  taskHandoff,
  wayIn,
  type TemperRead
} from './reads'
import { TemperOriginRefusedError } from './origin'
import { registerEditorRoom } from './editor-room/open-body'
import { readLaunchableAgents } from './agents'
import { registerSkillReadiness } from './skill-readiness/worker'
import { createPendingLaunches, registerServes, type PendingLaunch } from './serves'
import type {
  CapabilitiesOutput,
  FocusAgentInput,
  FocusAgentOutput,
  HandoffTasksInput,
  HandoffTasksOutput,
  LatestHandoffOutput,
  LaunchAgentsOutput,
  LaunchInput,
  LaunchLink,
  LaunchOutput,
  LaunchProjectsOutput,
  LinkedTasksInput,
  LinkedWorkspacesInput,
  LinkedWorkspacesOutput,
  LinkedTasksOutput,
  PlacesOutput,
  RecentOutput,
  RecordDetailInput,
  RecordDetailOutput,
  RegionFailure,
  ReopenInput,
  ReopenOutput,
  ResumeOutput,
  TaskHandoffInput,
  TaskHandoffOutput,
  WayInInput,
  WayInOutput
} from './protocol'
import {
  dropRemovedWorkspace,
  learnSessionFromEvent,
  linkedWorkspaces,
  listedRowFor,
  readLinks,
  storeLink
} from './links'
import { pathOfWorktreeId, placeMarker } from './serves-marker'

/** The agent kinds `agent.resume` takes; a link stores the kind the launch started. */
type ResumableAgent = HostParams<'agent.resume'>['agent']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const NOT_CONNECTED_MESSAGE =
  'temper is not connected — sign in with the temper CLI (`temper auth login`), then try again'

export default function activate(orca: OrcaWorkerApi): void {
  // One strategy per worker: its cache carries the refreshed token — and the origin minted
  // with it — across panel reads, the pair from one CLI conversation: the mint runs
  // export-token for the grant, then the origin question, asked only when the plugin setting
  // does not answer it. Two reads, one mint, one status run.
  const credentials = createCliCredentials({
    run: deps.run,
    originSetting: async () => {
      const value = await orca.settings.get('apiUrl')
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    }
  })

  const temperRead = async (): Promise<TemperRead> => ({
    apiUrl: await credentials.apiOrigin(),
    credentials,
    fetch: deps.fetch
  })

  // Losing the grant mid-read (a 401 through the client, a re-mint that finds the CLI signed
  // out) is the same refusal as never having it. An origin the CLI cannot name — a CLI too old
  // to report one, or one answering none — refuses in its own words. Any other failure is the
  // region's own: the panel names it, and the regions that answered stay.
  const refused = (error: unknown): boolean =>
    error instanceof TemperNotConnectedError ||
    error instanceof GrantLostError ||
    error instanceof TemperOriginRefusedError

  const refusalMessage = (error: unknown): string =>
    error instanceof TemperOriginRefusedError ? error.message : NOT_CONNECTED_MESSAGE

  // The grant gate: cached if still valid; the first read (and any later refresh) mints
  // through the CLI. Without it, refuse before any read is even attempted.
  async function answer<T>(
    run: (read: TemperRead) => Promise<T>
  ): Promise<T | RegionFailure> {
    try {
      await credentials.tokenResult()
      return await run(await temperRead())
    } catch (error) {
      if (refused(error)) {
        return { state: 'not-connected', message: refusalMessage(error) }
      }
      return { state: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  orca.panels.handle('temper.home.resume', async (): Promise<ResumeOutput> =>
    answer(async (read) => ({ state: 'ok' as const, ...(await resumeItem(read)) }))
  )

  orca.panels.handle('temper.home.handoff', async (): Promise<LatestHandoffOutput> =>
    answer(async (read) => ({ state: 'ok' as const, ...(await latestHandoff(read)) }))
  )

  orca.panels.handle(
    'temper.home.way-in',
    async (input: WayInInput): Promise<WayInOutput> =>
      answer(async (read) => ({ state: 'ok' as const, ...(await wayIn(read, input.id, input.bound, input.status)) }))
  )

  orca.panels.handle(
    'temper.resource.detail',
    async (input: RecordDetailInput): Promise<RecordDetailOutput> =>
      answer(async (read) => ({ state: 'ok' as const, detail: await resourceDetail(read, input.id) }))
  )

  orca.panels.handle(
    'temper.goal.tasks',
    async (input: LinkedTasksInput): Promise<LinkedTasksOutput> =>
      answer(async (read) => ({
        state: 'ok' as const,
        ...(await goalLinkedTasks(read, input.id, input.bound))
      }))
  )

  orca.panels.handle('temper.home.places', async (): Promise<PlacesOutput> =>
    answer(async (read) => ({ state: 'ok' as const, ...(await placesInUse(read)) }))
  )

  orca.panels.handle('temper.home.recent', async (): Promise<RecentOutput> =>
    answer(async (read) => ({ state: 'ok' as const, ...(await recentlyUpdated(read)) }))
  )

  // A task's own handoff for its start/resume prompt: a temper read, so the grant gate holds;
  // it names the task's newest linked session and never the person's latest (Review 1).
  orca.panels.handle(
    'temper.launch.task-handoff',
    async (input: TaskHandoffInput): Promise<TaskHandoffOutput> =>
      answer(async (read) => ({ state: 'ok' as const, ...(await taskHandoff(read, input.id)) }))
  )
  // The tasks a session advanced, with their stages as temper holds them now: the handoff
  // card names them, and its press reads them again to branch its prompt (ruling 28).
  orca.panels.handle(
    'temper.handoff.tasks',
    async (input: HandoffTasksInput): Promise<HandoffTasksOutput> =>
      answer(async (read) => ({ state: 'ok' as const, ...(await sessionTasks(read, input.sessionId)) }))
  )
  // The editor room (Open body): its own module, gated on the same grant.
  registerEditorRoom(orca, answer)
  // Agent skill readiness: the CLI's skill check per install target, and the Install press.
  registerSkillReadiness(orca)

  // What a workspace serves: the launch hook that gives an agent its task, and Home's strip.
  // The launches still out to workspace.create are held here for the hook (./serves.ts).
  const pendingLaunches = createPendingLaunches()
  registerServes(orca, answer, pendingLaunches)

  // The consents the host has granted, handed to the panel as they stand — the host re-checks
  // every call itself; the panel uses this to light and name actions, never to authorize one.
  orca.panels.handle('temper.capabilities', async (): Promise<CapabilitiesOutput> => ({
    granted: [...orca.grantedCapabilities]
  }))

  // The launcher handlers. None of them is a temper read, so none passes the grant gate
  // (`answer`) — launching writes nothing to temper (Rulings Q3); temper changes only when
  // the agent the press started acts, under the person's grant.

  /** What a host call's rejection carries, as words the panel can show. */
  const refusalCode = (error: unknown): string | null =>
    error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : null

  // The projects the person may start a new workspace in (`project.list`, hidden ones left
  // out). Orca's own refusal rides to the panel, where it is named as Orca said it.
  orca.panels.handle('temper.launch.projects', async (): Promise<LaunchProjectsOutput> => {
    try {
      const answer = await orca.host.call('project.list')
      return {
        state: 'ok',
        projects: answer.projects
          .filter((project) => project.hidden !== true)
          .map(({ id, name, path, hostId }) => ({ id, name, path, hostId }))
      }
    } catch (error) {
      return {
        state: 'failed',
        message: `Orca refused the projects read: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  })

  // The agents Orca can launch on this host (`orca agent installed`, ./agents.ts).
  orca.panels.handle('temper.launch.agents', async (): Promise<LaunchAgentsOutput> => readLaunchableAgents())

  // One launch. The press itself writes nothing to temper — the prompt the person saw goes to
  // workspace.create in the picked project, the host re-checks every consent itself, and a
  // refused call comes back as what Orca said. Every launch makes a new workspace — the
  // launcher's (decision ruling 23) and the editor room's "Hand to an agent" (ruling 25), in the
  // view workspace's project: Orca's agent.launch drops its prompt today (stablyai/orca#41107).
  // The new workspace is named as Orca then lists it. On success the workspace ↔ item link lands in the plugin's own storage
  // with the agent and its terminal, so its session can be learned for Reopen agent, and a
  // task's launch writes the serves marker in the workspace folder; a link that cannot be
  // stored rides along as `linkError`, a marker that cannot be written as `markerError`, and
  // neither ever takes the launch back.
  orca.panels.handle('temper.launch.go', async (input: LaunchInput): Promise<LaunchOutput> => {
    if (input.destination !== 'new-workspace') {
      return { state: 'failed', message: `unknown launch destination: ${String(input.destination)}` }
    }
    if (typeof input.agent !== 'string' || input.agent.trim() === '') {
      return { state: 'failed', message: 'no agent was named' }
    }
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
      return { state: 'failed', message: 'no prompt was sent — the launch asks for the one the person saw' }
    }
    if (!UUID.test(String(input.item?.id ?? ''))) {
      return { state: 'failed', message: 'a bare UUID names the item, and none was sent' }
    }
    if (typeof input.projectId !== 'string' || input.projectId.trim() === '') {
      return { state: 'failed', message: 'a new workspace needs the picked project, and none was sent' }
    }

    // Orca starts the agent before workspace.create returns, so its launch hook may run before
    // the link below is stored: the launch is held as pending until then (./serves.ts). The
    // pending link is the hook's only source then, so it must carry the item's context — and a
    // press whose item names none would hold a link to a task with a ref but no context
    // (TEMPER_TASK without TEMPER_CONTEXT). So when the item arrives without its context, the
    // worker reads the record's `context_ref` itself before the launch is held: a temper read
    // on the person's grant, inside the press, for what it would launch into. A read that
    // fails or is refused — signed out among them — blocks nothing: the launch runs with the
    // context the item arrived with, and the strip's record read still teaches the link
    // (./serves.ts `learnLink`).
    let contextRef = typeof input.item.contextRef === 'string' && input.item.contextRef.trim() !== ''
      ? input.item.contextRef
      : null
    if (contextRef === null) {
      try {
        const detail = await resourceDetail(await temperRead(), input.item.id)
        contextRef = detail.contextRef
      } catch {
        // Nothing is invented: the launch runs with what the press knew.
      }
    }
    const docType =
      typeof input.item.docType === 'string' && input.item.docType !== '' ? input.item.docType : undefined
    const pending: PendingLaunch = {
      projectId: input.projectId,
      agent: input.agent,
      link: {
        itemId: input.item.id,
        ref: input.item.ref,
        contextRef,
        startedAt: new Date().toISOString(),
        agent: input.agent,
        ...(typeof input.item.title === 'string' ? { title: input.item.title } : {}),
        ...(docType === undefined ? {} : { docType })
      }
    }
    pendingLaunches.add(pending)
    try {
      let workspaceId: string
      let terminalId: string | null = null
      try {
        const created = await orca.host.call('workspace.create', {
          projectId: input.projectId,
          agent: input.agent,
          prompt: input.prompt
        })
        workspaceId = created.workspaceId
        terminalId = created.terminalId ?? null
      } catch (error) {
        return {
          state: 'refused',
          code: refusalCode(error),
          message: error instanceof Error ? error.message : String(error)
        }
      }

      // The name the person knows the workspace by, and the project and path its worktree id
      // is made of (the launch hook's match). The create may answer Orca's worktree id
      // (`<project>::<path>`) rather than the listed one, so the row is found by either, and the
      // link keeps the listed id; a list that fails or lacks it names none, and a worktree id
      // still gives the project and path.
      let listedRow: { id: string; name: string; projectId?: string | null; path: string; hostId: string | null } | undefined
      try {
        const listed = await orca.host.call('workspace.list')
        listedRow = listedRowFor(listed.workspaces, { workspaceId })
      } catch {
        listedRow = undefined
      }
      const workspaceName = listedRow?.name ?? null
      const rawPath = pathOfWorktreeId(workspaceId)
      const place =
        listedRow !== undefined && typeof listedRow.projectId === 'string' && listedRow.projectId !== ''
          ? { projectId: listedRow.projectId, path: listedRow.path }
          : rawPath !== null && workspaceId.startsWith(`${input.projectId}::`)
            ? { projectId: input.projectId, path: rawPath }
            : {}
      const link: LaunchLink = {
        ...pending.link,
        workspaceId: listedRow?.id ?? workspaceId,
        terminalId,
        ...place
      }

      // The serves marker beside the link (decision ruling 27): any agent in the workspace can
      // read which task it serves. Written only on this machine; a failure is said, never fatal.
      let markerError: string | null = null
      const folder = listedRow?.path ?? rawPath
      if (folder === null || (listedRow !== undefined && listedRow.hostId !== null && listedRow.hostId !== 'local')) {
        markerError =
          link.docType === 'task'
            ? 'the serves marker was not written: Orca named no folder on this machine for the new workspace'
            : null
      } else {
        markerError = await placeMarker({ name: workspaceName ?? folder, path: folder }, link)
      }

      let linkError: string | null = null
      try {
        await storeLink(orca, link)
      } catch (error) {
        linkError = error instanceof Error ? error.message : String(error)
      }
      return { state: 'launched', workspaceId, workspaceName, terminalId, linkError, markerError }
    } finally {
      pendingLaunches.delete(pending)
    }
  })

  // The workspaces an item is linked to, named as Orca lists them — the sheet names them
  // before a second workspace is made, and Reopen agent is offered on the ones that carry a
  // session. Not a temper read: no grant gate.
  orca.panels.handle(
    'temper.launch.links',
    async (input: LinkedWorkspacesInput): Promise<LinkedWorkspacesOutput> => {
      if (!UUID.test(String(input?.itemId ?? ''))) {
        return { state: 'failed', message: 'a bare UUID names the item, and none was sent' }
      }
      try {
        return { state: 'ok', links: await linkedWorkspaces(orca, input.itemId) }
      } catch (error) {
        return {
          state: 'failed',
          message: `the linked workspaces could not be read: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
  )

  // Reopen agent: the same agent session, back in its workspace, through agent.resume with the
  // session the stored link carries — read here, never taken from the panel. No temper prompt
  // is sent and nothing is written to temper.
  orca.panels.handle('temper.reopen.go', async (input: ReopenInput): Promise<ReopenOutput> => {
    let link
    try {
      link = (await readLinks(orca)).find(
        (entry) => entry.itemId === input?.itemId && entry.workspaceId === input?.workspaceId
      )
    } catch (error) {
      return {
        state: 'failed',
        message: `the stored link could not be read: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (link === undefined) {
      return { state: 'failed', message: 'no stored link joins this item to that workspace' }
    }
    if (typeof link.sessionId !== 'string' || typeof link.agent !== 'string') {
      return { state: 'failed', message: 'the stored link carries no agent session to reopen' }
    }
    try {
      const resumed = await orca.host.call('agent.resume', {
        workspaceId: link.workspaceId,
        agent: link.agent as ResumableAgent,
        sessionId: link.sessionId
      })
      return { state: 'reopened', terminalId: resumed.terminalId, started: resumed.started }
    } catch (error) {
      return {
        state: 'refused',
        code: refusalCode(error),
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // Takes the person to an agent (./focus-agent.tsx): its terminal when one is known, else its
  // workspace — a chat tab cannot be focused (stablyai/orca#42069). Only Orca's view moves.
  orca.panels.handle('temper.agent.focus', async (input: FocusAgentInput): Promise<FocusAgentOutput> => {
    const terminalId = typeof input?.terminalId === 'string' && input.terminalId !== '' ? input.terminalId : null
    if (terminalId === null && (typeof input?.workspaceId !== 'string' || input.workspaceId === '')) {
      return { state: 'failed', message: 'neither a terminal nor a workspace was named' }
    }
    try {
      if (terminalId !== null) {
        const answer = await orca.host.call('terminal.focus', { terminalId })
        return { state: 'shown', via: 'terminal', focused: answer.focused }
      }
      await orca.host.call('workspace.open', { workspaceId: input.workspaceId })
      return { state: 'shown', via: 'workspace', focused: true }
    } catch (error) {
      return {
        state: 'refused',
        code: refusalCode(error),
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // The link's upkeep: a removed workspace's links are dropped; a linked launch's session is
  // learned when Orca names it in that launch's own terminal.
  orca.events.on('workspace.removed', (payload) => dropRemovedWorkspace(orca, payload))
  orca.events.on('agent.status.changed', (payload) => learnSessionFromEvent(orca, payload))
}
