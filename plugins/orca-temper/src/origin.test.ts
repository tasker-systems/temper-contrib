// The origin resolver: the CLI's own `temper auth status --format json` answer, through the
// same run seam as the token mint. The confirmed shape is a top-level `api_url` string, present
// signed in and signed out, never omitted, null only for an in-process client with no wire
// origin; the refusals name why, never a guess.
import { assert, test } from 'orca/testing'
import {
  apiUrlFromAuthStatus,
  resolveApiOrigin,
  TemperOriginRefusedError
} from './origin'

/** Runs the parser and hands back the TemperOriginRefusedError it raised, or fails the test. */
function refusedParsing(authStatus: string): TemperOriginRefusedError {
  try {
    apiUrlFromAuthStatus(authStatus)
  } catch (error) {
    if (error instanceof TemperOriginRefusedError) {
      return error
    }
    throw error
  }
  throw new Error('the origin question must refuse here, never guess')
}

const SIGNED_IN_STATUS = JSON.stringify({ authenticated: true, api_url: 'https://temper.example' })

test('reads the api_url temper auth status reports', () => {
  assert.equal(apiUrlFromAuthStatus(SIGNED_IN_STATUS), 'https://temper.example')
})

test('a reported origin signed out is answered the same as signed in', () => {
  const status = JSON.stringify({ authenticated: false, api_url: 'https://temper.example' })
  assert.equal(apiUrlFromAuthStatus(status), 'https://temper.example')
})

test('the reported origin is trimmed and its trailing slash dropped', () => {
  assert.equal(
    apiUrlFromAuthStatus(JSON.stringify({ api_url: '  https://temper.example/  ' })),
    'https://temper.example'
  )
  assert.equal(
    apiUrlFromAuthStatus(JSON.stringify({ api_url: 'https://temper.example/api//' })),
    'https://temper.example/api'
  )
})

test('a CLI too old to carry the field refuses, naming what temper is needed', () => {
  // The field's contract is "never omitted" — an answer without it is an old CLI, and the
  // refusal names the temper it takes, not a guess at the instance.
  const oldCli = JSON.stringify({ authenticated: true })
  assert.match(refusedParsing(oldCli).message, /too old/)
  assert.match(refusedParsing(oldCli).message, /98de84dc/)
  assert.match(refusedParsing(oldCli).message, /"Temper API origin" setting/)
})

test('a null api_url refuses naming the in-process CLI, never guessing', () => {
  const status = JSON.stringify({ authenticated: true, api_url: null })
  assert.match(refusedParsing(status).message, /api_url null/)
})

test('an api_url of any other shape refuses rather than coercing', () => {
  for (const answer of ['{}', JSON.stringify({ api_url: 7 }), 'not json at all']) {
    const refusal = refusedParsing(answer)
    assert.ok(refusal.message.trim() !== '')
  }
  assert.match(refusedParsing('not json at all').message, /answered no JSON/)
})

test('a whitespace-only origin refuses — no origin is still no origin', () => {
  for (const authStatus of [JSON.stringify({ api_url: '' }), JSON.stringify({ api_url: '   ' })]) {
    refusedParsing(authStatus)
  }
})

test('asks the CLI for auth status through the run seam, in the mint env', async () => {
  const asked: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
  const run = async (args: readonly string[], env: NodeJS.ProcessEnv) => {
    asked.push({ args, env })
    return { code: 0, stdout: `${SIGNED_IN_STATUS}\n`, stderr: '' }
  }
  const origin = await resolveApiOrigin(run, { TEMPER_TOKEN: 'ambient', HOME: '/home/person' })
  assert.equal(origin, 'https://temper.example')
  assert.deepEqual(asked[0]?.args, ['auth', 'status', '--format', 'json'])
  // The person's on-disk grant answers, as the token mint mints: TEMPER_TOKEN never rides.
  assert.equal('TEMPER_TOKEN' in (asked[0]?.env ?? {}), false)
  assert.equal((asked[0]?.env ?? {}).HOME, '/home/person')
})

test('a failing auth status refuses with the CLI saying why', async () => {
  const run = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
    code: 1,
    stdout: '{"code":"UNAUTHENTICATED","message":"not signed in"}',
    stderr: 'auth status: no grant\n'
  })
  try {
    await resolveApiOrigin(run, {})
  } catch (error) {
    assert.ok(error instanceof TemperOriginRefusedError)
    assert.match(error.message, /temper auth status failed/)
    assert.match(error.message, /no grant/)
    return
  }
  throw new Error('the failing auth status must refuse')
})
