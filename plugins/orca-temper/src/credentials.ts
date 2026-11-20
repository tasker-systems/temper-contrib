// A temper-ts `Credentials` strategy whose mint is `temper auth export-token`: the plugin borrows
// the person's grant from the CLI they already signed in to, and this file is the only way a
// token ever enters the worker. It never reads the CLI's auth store or its lock (the CLI rotates
// the refresh token under an OS lock; a second reader would race it). The mint also names the
// API origin the token is presented to — the plugin setting answers at mint time when it is set,
// otherwise `temper auth status` does — and the token and its origin travel as one pair: a
// refresh resolves both again, and a cached token never travels without its origin.
import type { Credentials, TokenResult } from '../vendor/temper-ts.mjs'
import { resolveApiOrigin, TemperOriginRefusedError } from './origin'
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
  /**
   * The plugin setting's answer at mint time: a non-empty string is the origin the mint pairs
   * the token with (the CLI is never asked for one), null or empty sends the mint to `temper
   * auth status`. The option's presence turns the mint into a pair mint — token plus origin —
   * so a read answered from the cache carries a token and an origin from one CLI conversation,
   * and a refresh resolves both again. Omit the option and the strategy is token-only.
   */
  originSetting?: () => Promise<string | null>
  /** Injectable clock (ms since epoch) — tests drive expiry without sleeping. */
  now?: () => number
}

/** The pair strategy: temper-ts's `Credentials` plus the origin the minted token travels with. */
export type PairCredentials = Credentials & { apiOrigin: () => Promise<string> }

/**
 * The borrowed-grant strategy. Each mint runs `export-token` — stdout is trusted ONLY on exit 0,
 * on failure the CLI prints a JSON error payload on stdout, and a token read from there would be
 * an error document served as a bearer — and then resolves the origin, caching both as one pair:
 * a failed origin resolution leaves nothing cached, and a token minted alone is minted again.
 */
export function createCliCredentials({
  run,
  now = Date.now,
  originSetting
}: CliCredentialsOptions): PairCredentials {
  let cached: TokenResult | null = null
  let cachedOrigin: string | null = null
  let inflight: Promise<TokenResult> | null = null

  /** The origin the mint travels with: the setting answers first, otherwise the CLI does. */
  async function mintOrigin(): Promise<string> {
    if (originSetting) {
      const value = await originSetting()
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim()
      }
    }
    return resolveApiOrigin(run, process.env)
  }

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
    // Caching waits for the pair: an origin the CLI cannot name refuses the mint whole, and the
    // next read mints again rather than trusting a token that travelled without an origin.
    const origin = originSetting ? await mintOrigin() : null
    cached = result
    cachedOrigin = origin
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

  /**
   * The origin the minted token is presented to. When nothing is cached the mint completes
   * first (the pair resolves together) — this never asks the CLI on its own account.
   */
  async function apiOrigin(): Promise<string> {
    if (cachedOrigin === null) {
      await tokenResult()
    }
    if (cachedOrigin === null) {
      throw new TemperOriginRefusedError(
        'the borrowed token carries no API origin — its mint did not name one'
      )
    }
    return cachedOrigin
  }

  return {
    canRefresh: true,
    token: async () => (await tokenResult()).token,
    tokenResult,
    refresh,
    apiOrigin
  }
}
