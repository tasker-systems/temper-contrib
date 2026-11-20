// The credential strategy in isolation: the borrowed grant is trusted only on exit 0, its
// expiry comes from the JWT's exp, and concurrent refreshes run the CLI once.
import { assert, test } from 'orca/testing'
import { createCliCredentials, TemperNotConnectedError } from './credentials'
import type { CommandResult } from './deps'

function fakeToken(expiresAtSeconds: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'none' })}.${encode({ exp: expiresAtSeconds })}.sig`
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
