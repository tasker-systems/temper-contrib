// The credential strategy in isolation: the borrowed grant is trusted only on exit 0, its
// expiry comes from the JWT's exp, and concurrent refreshes run the CLI once. When the worker
// asks for an origin as well, the mint resolves the pair — token, then origin — and caches both
// together; an origin the mint cannot name refuses the mint whole.
import { assert, test } from 'orca/testing'
import { createCliCredentials, TemperNotConnectedError } from './credentials'
import { TemperOriginRefusedError } from './origin'
import type { CommandResult } from './deps'

function fakeToken(expiresAtSeconds: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'none' })}.${encode({ exp: expiresAtSeconds })}.sig`
}

/** Dispatches: the mint's export-token, or the origin question. */
function cliPair(
  answers: (args: readonly string[]) => CommandResult,
  asked: string[][]
): (args: readonly string[]) => Promise<CommandResult> {
  return async (args) => {
    asked.push([...args])
    return answers(args)
  }
}

test('trusts stdout only on exit 0: a JSON payload beside a non-zero exit is not a token', async () => {
  // What the CLI actually does signed out: exit 1, error JSON on stdout.
  const signedOut: CommandResult = {
    code: 1,
    stdout: '{"code":"UNAUTHENTICATED","message":"not signed in"}',
    stderr: ''
  }
  const credentials = createCliCredentials({ run: async () => signedOut, now: () => 0 })
  await assert.rejects(credentials.token(), (error: unknown) => {
    assert.ok(error instanceof TemperNotConnectedError)
    assert.match(error.message, /temper is not connected/)
    return true
  })
})

test('takes expiresAt from the JWT exp claim', async () => {
  const token = fakeToken(1_000_000)
  const credentials = createCliCredentials({
    run: async () => ({ code: 0, stdout: `${token}\n`, stderr: '' }),
    now: () => 0
  })
  const result = await credentials.tokenResult()
  assert.equal(result.token, token)
  assert.equal(result.expiresAt, 1_000_000_000)
})

test('caches ahead of expiry and coalesces concurrent refreshes onto one CLI run', async () => {
  let runs = 0
  const token = fakeToken(1_000_000)
  const credentials = createCliCredentials({
    run: async () => {
      runs += 1
      return { code: 0, stdout: `${token}\n`, stderr: '' }
    },
    now: () => 0
  })
  const [a, b] = await Promise.all([credentials.token(), credentials.refresh()])
  assert.equal(a, token)
  assert.equal(b.token, token)
  assert.equal(runs, 1)
  // Within the skew no new run…
  await credentials.token()
  assert.equal(runs, 1)
  // …but once the cached token is inside the skew window, every resolve re-mints.
  const closer = createCliCredentials({
    run: async () => {
      runs += 1
      return { code: 0, stdout: `${token}\n`, stderr: '' }
    },
    now: () => 1_000_500_000 // past exp 1_000_000 s = 1_000_000_000 ms
  })
  await closer.token()
  await closer.token()
  assert.equal(runs, 3)
})

test('the mint pairs the token with the origin the CLI names, in one conversation', async () => {
  const asked: string[][] = []
  const token = fakeToken(1_000_000)
  const credentials = createCliCredentials({
    run: cliPair(
      (args) =>
        args[1] === 'status'
          ? { code: 0, stdout: `${JSON.stringify({ authenticated: true, api_url: 'https://cli.example' })}\n`, stderr: '' }
          : { code: 0, stdout: `${token}\n`, stderr: '' },
      asked
    ),
    originSetting: async () => null,
    now: () => 0
  })
  const result = await credentials.tokenResult()
  assert.equal(result.token, token)
  assert.equal(await credentials.apiOrigin(), 'https://cli.example')
  // One CLI conversation per mint: the grant, then the origin question.
  assert.deepEqual(asked.map((args) => args.slice(0, 2)), [['auth', 'export-token'], ['auth', 'status']])
  // Within the cached pair no new run answers either question.
  await credentials.tokenResult()
  await credentials.apiOrigin()
  assert.equal(asked.length, 2)
})

test('a set plugin setting pairs with the token, and the CLI is never asked for an origin', async () => {
  const asked: string[][] = []
  const token = fakeToken(1_000_000)
  const credentials = createCliCredentials({
    run: cliPair(() => ({ code: 0, stdout: `${token}\n`, stderr: '' }), asked),
    originSetting: async () => 'https://setting.example',
    now: () => 0
  })
  await credentials.tokenResult()
  assert.equal(await credentials.apiOrigin(), 'https://setting.example')
  assert.deepEqual(asked.map((args) => args[1]), ['export-token'])
})

test('a mint whose origin fails refuses whole and caches nothing — the next read mints again', async () => {
  // The status answers (a too-old CLI carries no api_url): a token minted alone is not cached,
  // so the next read mints again instead of trusting a token that never got its origin.
  let mints = 0
  const token = fakeToken(1_000_000)
  const credentials = createCliCredentials({
    run: async (args) => {
      if (args[1] === 'status') {
        return { code: 0, stdout: `${JSON.stringify({ authenticated: true })}\n`, stderr: '' }
      }
      mints += 1
      return { code: 0, stdout: `${token}\n`, stderr: '' }
    },
    originSetting: async () => null,
    now: () => 0
  })
  // Both refuse in the origin's own words — and the second re-mints: had the first read's
  // token been cached without its origin, the second read would ride it (one run, one refusal).
  let refusals = 0
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await credentials.token()
    } catch (error) {
      if (error instanceof TemperOriginRefusedError && /too old/.test(error.message)) {
        refusals += 1
      }
    }
  }
  assert.equal(refusals, 2, 'a token without its origin is refused, never served')
  assert.equal(mints, 2, 'the unpaired token was not cached')
})

test('a token-only strategy answers apiOrigin with a refusal, never silently', async () => {
  // No originSetting option: no origin is resolved with the mint, and asking for one refuses
  // rather than inventing it.
  const token = fakeToken(1_000_000)
  const credentials = createCliCredentials({
    run: async () => ({ code: 0, stdout: `${token}\n`, stderr: '' }),
    now: () => 0
  })
  await credentials.tokenResult()
  await assert.rejects(credentials.apiOrigin(), (error: unknown) => {
    assert.ok(error instanceof TemperOriginRefusedError)
    return true
  })
})

test('a refresh re-resolves the pair: the old origin does not outlive the mint that named it', async () => {
  const asked: string[][] = []
  let mints = 0
  const credentials = createCliCredentials({
    run: cliPair(
      (args) => {
        if (args[1] === 'status') {
          return { code: 0, stdout: `${JSON.stringify({ authenticated: true, api_url: 'https://cli.example' })}\n`, stderr: '' }
        }
        mints += 1
        // exp just past the skew for the second mint: the caller's now() forces it below.
        return { code: 0, stdout: `${fakeToken(mints === 1 ? 1_000_000 : 2_100_000)}\n`, stderr: '' }
      },
      asked
    ),
    originSetting: async () => null,
    now: () => 1_000_900_000 // inside the 60 s skew of the first token: every resolve re-mints
  })
  await credentials.tokenResult()
  assert.equal(mints, 1)
  const second = await credentials.refresh()
  assert.equal(second.expiresAt, 2_100_000_000)
  assert.equal(await credentials.apiOrigin(), 'https://cli.example')
  assert.equal(
    asked.filter((args) => args[1] === 'status').length,
    2,
    'both mints named the origin'
  )
  assert.equal(
    asked.filter((args) => args[1] === 'export-token').length,
    2,
    'both mints ran the grant'
  )
})
