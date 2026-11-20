// The plugin's trusted worker. Every temper read goes: consult the ONE credential strategy this
// worker holds (its cache carries the refreshed token across panel reads; a read never mints a
// fresh token when a valid one is cached), then read through temper-ts at the origin temper
// auth status names (the API the CLI presents the minted grant to). Without the grant — at
// mint time or lost mid-read — the answer is a refusal,
// never a guess, and never partial or cached group data. The panel shows the refusal text.
import type { OrcaWorkerApi } from 'orca/worker'
import { createCliCredentials, TemperNotConnectedError } from './credentials'
import { deps } from './deps'
import {
  activeGoals,
  GrantLostError,
  inProgressTasks,
  latestHandoff,
  type TemperRead
} from './reads'
import { resolveApiOrigin, TemperOriginRefusedError } from './origin'
import type {
  ActiveGoalsOutput,
  InProgressTasksOutput,
  LatestHandoffOutput
} from './protocol'

const NOT_CONNECTED_MESSAGE =
  'temper is not connected — sign in with the temper CLI (`temper auth login`), then try again'

const DEFAULT_CONTEXT_REF = '@me/temper'

// The panel reads goals from the goals contexts and work items from the work contexts. Each
// group's setting is a comma-separated list of context refs; unset, the group falls back to the
// single "Temper context" setting, and beyond that to @me/temper — today's behaviour.
async function settingContexts(
  orca: OrcaWorkerApi,
  listKey: string,
  fallbackKey: string
): Promise<string[]> {
  const value = await orca.settings.get(listKey)
  if (typeof value === 'string') {
    const refs = value
      .split(',')
      .map((ref) => ref.trim())
      .filter((ref) => ref !== '')
    if (refs.length > 0) {
      return refs
    }
  }
  const fallbackValue = await orca.settings.get(fallbackKey)
  const fallback =
    typeof fallbackValue === 'string' && fallbackValue.trim() !== ''
      ? fallbackValue.trim()
      : null
  return [fallback ?? DEFAULT_CONTEXT_REF]
}

/** The setting overrides; otherwise the origin the CLI itself names (`temper auth status`). */
async function apiOrigin(orca: OrcaWorkerApi): Promise<string> {
  const value = await orca.settings.get('apiUrl')
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim()
  }
  return resolveApiOrigin(deps.run, process.env)
}

export default function activate(orca: OrcaWorkerApi): void {
  // One strategy per worker: its cache and refresh-ahead span every panel read.
  const credentials = createCliCredentials({ run: deps.run })

  const temperRead = async (): Promise<TemperRead> => ({
    apiUrl: await apiOrigin(orca),
    credentials,
    fetch: deps.fetch
  })

  // Losing the grant mid-read (a 401 through the client, a re-mint that finds the CLI signed
  // out) is the same refusal as never having it. An origin the CLI cannot name — a CLI too old
  // to report one, or one answering none — refuses in its own words.
  const refused = (error: unknown): boolean =>
    error instanceof TemperNotConnectedError ||
    error instanceof GrantLostError ||
    error instanceof TemperOriginRefusedError

  const refusalMessage = (error: unknown): string =>
    error instanceof TemperOriginRefusedError ? error.message : NOT_CONNECTED_MESSAGE

  orca.panels.handle('temper.goals.active', async (): Promise<ActiveGoalsOutput> => {
    const contexts = await settingContexts(orca, 'goalsContexts', 'contextRef')
    try {
      // The grant gate: cached if still valid; the first read (and any later refresh) mints
      // through the CLI. Without it, refuse before any read is even attempted.
      await credentials.tokenResult()
      const { goals, truncated } = await activeGoals(await temperRead(), contexts)
      return { connected: true, contexts, goals, truncated }
    } catch (error) {
      if (refused(error)) {
        return { connected: false, contexts, message: refusalMessage(error) }
      }
      throw error
    }
  })

  orca.panels.handle('temper.tasks.in-progress', async (): Promise<InProgressTasksOutput> => {
    const contexts = await settingContexts(orca, 'workContexts', 'contextRef')
    try {
      await credentials.tokenResult()
      const { tasks, truncated } = await inProgressTasks(await temperRead(), contexts)
      return { connected: true, contexts, tasks, truncated }
    } catch (error) {
      if (refused(error)) {
        return { connected: false, contexts, message: refusalMessage(error) }
      }
      throw error
    }
  })

  orca.panels.handle('temper.handoff.latest', async (): Promise<LatestHandoffOutput> => {
    const contexts = await settingContexts(orca, 'workContexts', 'contextRef')
    try {
      await credentials.tokenResult()
      const { handoff, truncated } = await latestHandoff(await temperRead(), contexts)
      return { connected: true, contexts, truncated, handoff }
    } catch (error) {
      if (refused(error)) {
        return { connected: false, contexts, message: refusalMessage(error) }
      }
      throw error
    }
  })
}
