// A temper-ts `Credentials` strategy whose mint is `temper auth export-token`: the plugin borrows
// the person's grant from the CLI they already signed in to, and this file is the only way a
// token ever enters the worker. It never reads the CLI's auth store or its lock (the CLI rotates
// the refresh token under an OS lock; a second reader would race it).
import type { Credentials, TokenResult } from '../vendor/temper-ts.mjs'
import type { RunCli } from './deps'

/** The signed-out refusal: `temper auth export-token` exited non-zero. */
export class TemperNotConnectedError extends Error {
  constructor(detail: string) {
    super(`temper is not connected: ${detail}`)
    this.name = 'TemperNotConnectedError'
  }
}

/** Re-mint this far ahead of the JWT's `exp` rather than racing it. */
const REFRESH_SKEW_MS = 60_000

/**
 * The JWT's absolute expiry, ms since epoch, from its `exp` claim. Only the claim is read; the
 * signature is temper's to check when the token is presented.
 */
function expiryOf(token: string): number {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error(`export-token yielded something that is not a JWT (${parts.length} segments)`)
  }
  // `parts[1]` is defined: the length check above guarantees three segments.
  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
    exp?: unknown
  }
  if (typeof payload.exp !== 'number') {
    throw new Error('export-token yielded a JWT with no numeric exp claim')
  }
  return payload.exp * 1000
}

export interface CliCredentialsOptions {
  run: RunCli
  /** Injectable clock (ms since epoch) — tests drive expiry without sleeping. */
  now?: () => number
}

/**
 * The borrowed-grant strategy. `refresh()` runs the CLI; stdout is trusted ONLY on exit 0 — on
 * failure the CLI prints a JSON error payload on stdout, and a token read from there would be an
 * error document served as a bearer.
 */
export function createCliCredentials({ run, now = Date.now }: CliCredentialsOptions): Credentials {
  let cached: TokenResult | null = null
  let inflight: Promise<TokenResult> | null = null

  async function mint(): Promise<TokenResult> {
    // The CLI refuses export-token when TEMPER_TOKEN or TEMPER_AUTH=ambient is set: drop both from
    // the child's environment so the CLI always answers from the person's on-disk grant.
    const env = { ...process.env }
    delete env.TEMPER_TOKEN
    delete env.TEMPER_AUTH
    const { code, stdout, stderr } = await run(['auth', 'export-token'], env)
    if (code !== 0) {
      const lines = stderr.trim().split('\n')
      throw new TemperNotConnectedError(lines[lines.length - 1] ?? `the CLI exited ${code}`)
    }
    const token = stdout.trim()
    const result: TokenResult = { token, expiresAt: expiryOf(token) }
    cached = result
    return result
  }

  /** Mint unconditionally, with concurrent callers coalesced onto one CLI run. */
  function refresh(): Promise<TokenResult> {
    if (!inflight) {
      inflight = mint().finally(() => {
        inflight = null
      })
    }
    return inflight
  }

  async function tokenResult(): Promise<TokenResult> {
    if (cached && now() + REFRESH_SKEW_MS < cached.expiresAt) {
      return cached
    }
    return refresh()
  }

  return {
    canRefresh: true,
    token: async () => (await tokenResult()).token,
    tokenResult,
    refresh
  }
}
