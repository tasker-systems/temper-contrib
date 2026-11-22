// The agents Orca can launch on this host: the host API has no enumeration, so the question goes
// to the host's own CLI (`orca agent installed --json` — the public command, never the
// undocumented RPC beneath it). A failed run fails the list rather than guessing a set. The
// launcher's agent pick and the skill readiness lines read the same answer.
import { deps } from './deps'
import type { LaunchAgentsOutput } from './protocol'

export async function readLaunchableAgents(): Promise<LaunchAgentsOutput> {
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
}
