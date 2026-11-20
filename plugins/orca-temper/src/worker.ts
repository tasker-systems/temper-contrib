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
  latestHandoff,
  placesInUse,
  recentlyUpdated,
  resumeItem,
  wayIn,
  type TemperRead
} from './reads'
import { TemperOriginRefusedError } from './origin'
import type {
  CapabilitiesOutput,
  LatestHandoffOutput,
  PlacesOutput,
  RecentOutput,
  RegionFailure,
  ResumeOutput,
  WayInInput,
  WayInOutput
} from './protocol'

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

  orca.panels.handle('temper.home.places', async (): Promise<PlacesOutput> =>
    answer(async (read) => ({ state: 'ok' as const, ...(await placesInUse(read)) }))
  )

  orca.panels.handle('temper.home.recent', async (): Promise<RecentOutput> =>
    answer(async (read) => ({ state: 'ok' as const, ...(await recentlyUpdated(read)) }))
  )

  // The consents the host has granted, handed to the panel as they stand — the host re-checks
  // every call itself; the panel uses this to light and name actions, never to authorize one.
  orca.panels.handle('temper.capabilities', async (): Promise<CapabilitiesOutput> => ({
    granted: [...orca.grantedCapabilities]
  }))
}
