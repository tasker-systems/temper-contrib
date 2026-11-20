// Where the temper API lives, answered by the CLI itself: `temper auth status --format json`
// reports the origin at top level as `api_url` — the client's base URL with any trailing `/`
// trimmed, present signed in and signed out, never omitted. The token is minted by the CLI and
// presented to the API the CLI names, so asking the CLI is the whole story; the plugin never
// reads temper's own config or auth store to answer it. A plugin setting may override the
// origin; the refusal to guess is deliberate — the worker never invents an instance.

import type { RunCli } from './deps'

/**
 * The origin question's refusal: the CLI cannot name the API the borrowed grant is presented
 * to. The plugin setting answers the question instead — without it, the panel shows this.
 */
export class TemperOriginRefusedError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'TemperOriginRefusedError'
  }
}

export const TOO_OLD_MESSAGE =
  'this temper CLI is too old to name its API origin: `temper auth status` answers no api_url. ' +
  'A temper CLI built from main on or after 2026-11-19 (temper 98de84dc) does — upgrade temper, ' +
  'or set this plugin\'s "Temper API origin" setting.'

const NULL_URL_MESSAGE =
  'temper auth status reports api_url null — this CLI answers in-process, with no wire origin. ' +
  'Set this plugin\'s "Temper API origin" setting to name the instance the worker reads.'

/**
 * The env the CLI is asked in: `TEMPER_TOKEN` and `TEMPER_AUTH` dropped, exactly as the
 * export-token mint does, so the status answers from the person's on-disk grant — the grant
 * the token mint mints, and the origin that mint is presented to.
 */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env }
  delete child.TEMPER_TOKEN
  delete child.TEMPER_AUTH
  return child
}

/**
 * The `api_url` the auth-status JSON reports, or a refusal that says why: absent means a CLI
 * too old to carry the field, null means an in-process client with no wire origin, anything
 * else unexpected means the CLI's answer cannot be trusted as an origin.
 */
export function apiUrlFromAuthStatus(authStatus: string): string {
  let parsed: { api_url?: unknown }
  try {
    parsed = JSON.parse(authStatus) as { api_url?: unknown }
  } catch {
    throw new TemperOriginRefusedError(
      'temper auth status --format json answered no JSON — the temper CLI is broken or too old'
    )
  }
  if (!('api_url' in parsed)) {
    throw new TemperOriginRefusedError(TOO_OLD_MESSAGE)
  }
  const value = parsed.api_url
  if (value === null) {
    throw new TemperOriginRefusedError(NULL_URL_MESSAGE)
  }
  if (typeof value !== 'string') {
    throw new TemperOriginRefusedError(
      `temper auth status reports api_url as ${typeof value}, not a string or null`
    )
  }
  const url = value.trim().replace(/\/+$/, '')
  if (url === '') {
    throw new TemperOriginRefusedError('temper auth status reports api_url empty')
  }
  return url
}

/**
 * The origin the CLI itself names: `temper auth status --format json` through the same `run`
 * seam as the token mint. stdout is trusted only on exit 0; a non-zero exit is a refusal naming
 * the CLI's answer, never a guess at the instance.
 */
export async function resolveApiOrigin(
  run: RunCli,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const { code, stdout, stderr } = await run(['auth', 'status', '--format', 'json'], childEnv(env))
  if (code !== 0) {
    const lines = stderr.trim().split('\n')
    throw new TemperOriginRefusedError(
      `temper auth status failed: ${lines[lines.length - 1] ?? `the CLI exited ${code}`}`
    )
  }
  return apiUrlFromAuthStatus(stdout)
}
