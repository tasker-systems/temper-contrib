// The plugin's trusted worker. Every temper read goes: consult the ONE credential strategy this
// worker holds (its cache carries the refreshed token across panel reads; a read never mints a
// fresh token when a valid one is cached), then read through temper-ts at the origin the CLI is
// configured for. Without the grant — at mint time or lost mid-read — the answer is a refusal,
// never a guess, and never partial or cached goal data. The panel shows the refusal text.
import type { OrcaWorkerApi } from 'orca/worker'
import { createCliCredentials, TemperNotConnectedError } from './credentials'
import { deps } from './deps'
import { activeGoals, GrantLostError } from './goals'
import { resolveApiOrigin } from './origin'
import type { ActiveGoalsOutput } from './protocol'

const NOT_CONNECTED_MESSAGE =
  'temper is not connected — sign in with the temper CLI (`temper auth login`), then try again'

const NO_ORIGIN_MESSAGE =
  'no temper API origin resolved: set this plugin\'s "Temper API origin" setting, ' +
  'or [cloud] api_url in the CLI config (`temper config edit`), or TEMPER_API_URL'

async function settingString(orca: OrcaWorkerApi, key: string): Promise<string | null> {
  const value = await orca.settings.get(key)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** The setting overrides; otherwise the origin the CLI (and so the token) is configured for. */
async function apiOrigin(orca: OrcaWorkerApi): Promise<string> {
  const fromSettings = await settingString(orca, 'apiUrl')
  if (fromSettings !== null) {
    return fromSettings
  }
  const resolved = resolveApiOrigin(process.env, deps.readTextFile)
  if (resolved !== null) {
    return resolved
  }
  throw new Error(NO_ORIGIN_MESSAGE)
}

export default function activate(orca: OrcaWorkerApi): void {
  // One strategy per worker: its cache and refresh-ahead span every panel read.
  const credentials = createCliCredentials({ run: deps.run })

  orca.panels.handle('temper.goals.active', async (): Promise<ActiveGoalsOutput> => {
    const contextRef = (await settingString(orca, 'contextRef')) ?? '@me/temper'
    try {
      // The grant gate: cached if still valid; the first read (and any later refresh) mints
      // through the CLI. Without it, refuse before any read is even attempted.
      await credentials.tokenResult()
      const { goals, truncated } = await activeGoals({
        apiUrl: await apiOrigin(orca),
        contextRef,
        credentials,
        fetch: deps.fetch
      })
      return { connected: true, contextRef, goals, truncated }
    } catch (error) {
      // Losing the grant mid-read (a 401 through the client, a re-mint that finds the CLI signed
      // out) is the same refusal as never having it.
      if (error instanceof TemperNotConnectedError || error instanceof GrantLostError) {
        return { connected: false, contextRef, message: NOT_CONNECTED_MESSAGE }
      }
      throw error
    }
  })
}
