// The plugin's trusted worker. Every temper read goes: consult the ONE credential strategy this
// worker holds (its cache carries the refreshed token across panel reads; a read never mints a
// fresh token when a valid one is cached), then read through temper-ts at the origin temper
// auth status names (the API the CLI presents the minted grant to). Home's reads are
// temper-ui's home reads for the same person — the context-scoped lists and their settings are
// retired. Without the grant — at mint time or lost mid-read — the answer is a refusal, never a
// guess, and never partial or cached region data; the panel shows the refusal text. A read that
// fails any other way is that region's failure, beside the regions that answered.
import type { OrcaWorkerApi } from 'orca/worker'
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
  taskHandoff,
  wayIn,
  type TemperRead
} from './reads'
import { TemperOriginRefusedError } from './origin'
import { registerEditorRoom } from './editor-room/open-body'
import type {
  CapabilitiesOutput,
  LatestHandoffOutput,
  LaunchAgentsOutput,
  LaunchInput,
  LaunchOutput,
  LaunchProjectsOutput,
  LinkedTasksInput,
  LinkedTasksOutput,
  PlacesOutput,
  RecentOutput,
  RecordDetailInput,
  RecordDetailOutput,
  RegionFailure,
  ResumeOutput,
  TaskHandoffInput,
  TaskHandoffOutput,
  WayInInput,
  WayInOutput
} from './protocol'
import { LAUNCH_LINKS_KEY } from './protocol'

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
      answer(async (read) => ({ state: 'ok' as const, ...(await wayIn(read, input.id, input.bound)) }))
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
  // The editor room (Open body): its own module, gated on the same grant.
  registerEditorRoom(orca, answer)

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

  // The agents Orca can launch on this host: the host API has no enumeration, so the question
  // goes to the host's own CLI (`orca agent installed --json` — the public command, never the
  // undocumented RPC beneath it). A failed run fails the pick list rather than guessing a set.
  orca.panels.handle('temper.launch.agents', async (): Promise<LaunchAgentsOutput> => {
    let result
    try {
      result = await deps.runOrca(['agent', 'installed', '--json'], process.env)
    } catch (error) {
      return {
        state: 'failed',
        message: `the Orca CLI could not be run: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (result.code !== 0) {
      const words = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? ''
      return { state: 'failed', message: `Orca would not name its agents: ${words || `exit ${result.code}`}` }
    }
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      const box = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      const resultBox =
        box['result'] !== null && typeof box['result'] === 'object'
          ? (box['result'] as Record<string, unknown>)
          : box
      const agents = Array.isArray(resultBox['agents']) ? resultBox['agents'] : []
      const named = agents
        .filter(
          (agent): agent is { id: string; name?: unknown; default?: unknown } =>
            agent !== null && typeof agent === 'object' && typeof (agent as { id?: unknown }).id === 'string'
        )
        .map((agent) => ({
          id: agent.id,
          name: typeof agent['name'] === 'string' ? (agent['name'] as string) : agent.id,
          isDefault: agent['default'] === true
        }))
      return { state: 'ok', agents: named }
    } catch (error) {
      return {
        state: 'failed',
        message: `Orca's agent list could not be read: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  })

  // One launch. The press itself writes nothing to temper — the prompt the person saw goes to
  // workspace.create (a new workspace in the picked project) or agent.launch (this workspace),
  // the host re-checks every consent itself, and a refused call comes back as what Orca said.
  // On success the workspace ↔ item link lands in the plugin's own storage, for item 7's
  // launch hook to read later; a link that cannot be stored rides along as `linkError` and
  // never takes the launch back.
  orca.panels.handle('temper.launch.go', async (input: LaunchInput): Promise<LaunchOutput> => {
    if (input.destination !== 'new-workspace' && input.destination !== 'this-workspace') {
      return { state: 'failed', message: `unknown launch destination: ${String(input.destination)}` }
    }
    if (typeof input.agent !== 'string' || input.agent.trim() === '') {
      return { state: 'failed', message: 'no agent was named' }
    }
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
      return { state: 'failed', message: 'no prompt was sent — the launch asks for the one the person saw' }
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(input.item?.id ?? ''))) {
      return { state: 'failed', message: 'a bare UUID names the item, and none was sent' }
    }
    if (input.destination === 'new-workspace' && (typeof input.projectId !== 'string' || input.projectId.trim() === '')) {
      return { state: 'failed', message: 'a new workspace needs the picked project, and none was sent' }
    }
    if (input.destination === 'this-workspace' && (typeof input.workspaceId !== 'string' || input.workspaceId.trim() === '')) {
      return { state: 'failed', message: 'this workspace was named by no id' }
    }

    let workspaceId: string
    let terminalId: string | null = null
    try {
      if (input.destination === 'new-workspace') {
        const created = await orca.host.call('workspace.create', {
          projectId: input.projectId as string,
          agent: input.agent,
          prompt: input.prompt
        })
        workspaceId = created.workspaceId
        terminalId = created.terminalId ?? null
      } else {
        const launched = await orca.host.call('agent.launch', {
          workspaceId: input.workspaceId as string,
          agent: input.agent,
          prompt: input.prompt
        })
        workspaceId = input.workspaceId as string
        terminalId = launched.terminalId
      }
    } catch (error) {
      return {
        state: 'refused',
        code: refusalCode(error),
        message: error instanceof Error ? error.message : String(error)
      }
    }

    let linkError: string | null = null
    try {
      const existing = await orca.storage.get(LAUNCH_LINKS_KEY)
      const rows = (Array.isArray(existing) ? existing : []).map((entry) =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : {}
      )
      const links = rows.filter(
        (entry) => typeof entry['workspaceId'] === 'string' && typeof entry['itemId'] === 'string'
      ) as { [key: string]: string | null }[]
      const link = {
        workspaceId,
        itemId: input.item.id,
        ref: input.item.ref,
        contextRef: input.item.contextRef ?? null,
        startedAt: new Date().toISOString()
      }
      await orca.storage.set(LAUNCH_LINKS_KEY, [
        ...links.filter(
          (entry) => !(entry['workspaceId'] === link.workspaceId && entry['itemId'] === link.itemId)
        ),
        link
      ])
    } catch (error) {
      linkError = error instanceof Error ? error.message : String(error)
    }
    return { state: 'launched', workspaceId, terminalId, linkError }
  })
}
