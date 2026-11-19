// The plugin's trusted worker. Every temper read goes: ask the credential strategy for the
// person's grant (`temper auth export-token`), and only then read through temper-ts. Without the
// grant the answer is a refusal, never a guess — the panel shows the refusal text.
import type { OrcaWorkerApi } from 'orca/worker'
import { createCliCredentials, TemperNotConnectedError } from './credentials'
import { deps } from './deps'
import { activeGoals } from './goals'
import type { ActiveGoalsOutput } from './protocol'

const NOT_CONNECTED_MESSAGE =
  'temper is not connected — sign in with the temper CLI (`temper auth login`), then try again'

async function settingString(orca: OrcaWorkerApi, key: string, fallback: string): Promise<string> {
  const value = await orca.settings.get(key)
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('temper.goals.active', async (): Promise<ActiveGoalsOutput> => {
    const contextRef = await settingString(orca, 'contextRef', '@me/temper')
    // The grant gate: mint (or refresh) the borrowed token BEFORE any read is attempted. A
    // non-zero `export-token` means the person is not connected — refuse, with no goal data.
    const credentials = createCliCredentials({ run: deps.run })
    try {
      await credentials.refresh()
    } catch (error) {
      if (error instanceof TemperNotConnectedError) {
        return { connected: false, contextRef, message: NOT_CONNECTED_MESSAGE }
      }
      throw error
    }
    const apiUrl = await settingString(orca, 'apiUrl', 'https://temper-cloud.vercel.app')
    const { goals, truncated } = await activeGoals({
      apiUrl,
      contextRef,
      credentials,
      fetch: deps.fetch
    })
    return { connected: true, contextRef, goals, truncated }
  })
}
