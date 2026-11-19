// Worker tests over the orca host mock, with deps.ts standing in for the temper CLI and the
// network. The first test is the witness `orca_worker_refuses_without_the_persons_grant`:
// with the CLI answering non-zero (signed out) and the network WILLING to hand goals over,
// the worker must still refuse and return no goal data.
import { assert, mockHost, mountWorker, test, afterEach } from 'orca/testing'
import { deps, type CommandResult } from './deps'
import * as main from './worker'

/** A syntactically valid unsigned JWT whose payload is just an `exp`. */
function fakeToken(expiresAtSeconds: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'none' })}.${encode({ exp: expiresAtSeconds })}.sig`
}

const TOKEN = fakeToken(4_102_444_800) // 2100-01-01, comfortably ahead of any run

/** A ResourceListResponse answering with two goals whenever the network is asked. */
const GOALS_RESPONSE = {
  facets: {},
  limit: 1000,
  offset: 0,
  returned: 2,
  truncated: false,
  total: 2,
  rows: [
    { id: '00000000-0000-7000-8000-0000000000a1', ref: 'goal-one-00000000-0000-7000-8000-0000000000a1', title: 'Goal one' },
    { id: '00000000-0000-7000-8000-0000000000b2', ref: 'goal-two-00000000-0000-7000-8000-0000000000b2', title: 'Goal two' }
  ]
}

/** The CLI's signed-out shape: exit 1, its JSON error payload on STDOUT. */
const SIGNED_OUT: CommandResult = {
  code: 1,
  stdout: '{"code":"UNAUTHENTICATED","message":"not signed in"}',
  stderr: 'export-token: token export is a privileged act\n'
}

const originalDeps = { ...deps }
afterEach(() => {
  deps.run = originalDeps.run
  deps.fetch = originalDeps.fetch
  deps.readTextFile = originalDeps.readTextFile
})

test('orca_worker_refuses_without_the_persons_grant', async () => {
  let runs = 0
  const requests: Request[] = []
  deps.run = async () => {
    runs += 1
    return SIGNED_OUT
  }
  deps.fetch = async (input: Request) => {
    requests.push(input)
    return new Response(JSON.stringify(GOALS_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const host = mockHost({ settings: { contextRef: '@me/temper' } })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.goals.active')

  assert.equal(answer.connected, false)
  assert.match(answer.message, /temper is not connected/)
  // No goal data rides the refusal — neither of the goals the network WOULD have returned.
  const serialized = JSON.stringify(answer)
  assert.equal(serialized.includes('Goal one'), false)
  assert.equal(serialized.includes('Goal two'), false)
  assert.equal(serialized.includes('00000000-0000-7000-8000'), false)
  // The refusal must come from consulting the credential strategy, not from guessing.
  assert.ok(runs > 0, 'the worker never asked the credential strategy for a token')
  assert.equal(requests.length, 0, 'signed out, the worker must not even ask the API')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('losing the grant mid-read is the same refusal', async () => {
  // The mint at the gate succeeds, the API refuses the token it presents, and the re-mint the
  // client tries discovers the CLI signed out — the answer is still the refusal, no goal data.
  let runs = 0
  deps.run = async () => {
    runs += 1
    return runs === 1 ? { code: 0, stdout: `${TOKEN}\n`, stderr: '' } : SIGNED_OUT
  }
  deps.fetch = async () =>
    new Response(
      JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'bad token' } }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    )

  const host = mockHost({
    settings: { contextRef: '@me/temper', apiUrl: 'https://temper.example' }
  })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.goals.active')

  assert.equal(answer.connected, false)
  assert.match(answer.message, /temper is not connected/)
  assert.equal(JSON.stringify(answer).includes('Goal one'), false)
  assert.equal(runs, 2, 'the gate minted once; the 401 re-mint found the CLI signed out')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('answers the person\'s active goals on the CLI\'s borrowed grant', async () => {
  const requests: Request[] = []
  let runs = 0
  deps.run = async () => {
    runs += 1
    return { code: 0, stdout: `${TOKEN}\n`, stderr: 'export-token: heads-up\n' }
  }
  deps.fetch = async (input: Request) => {
    requests.push(input)
    return new Response(JSON.stringify(GOALS_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const host = mockHost({
    settings: { contextRef: '@me/temper', apiUrl: 'https://temper.example' }
  })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.goals.active')

  assert.equal(answer.connected, true)
  if (!answer.connected) return
  assert.equal(answer.contextRef, '@me/temper')
  assert.deepEqual(
    answer.goals,
    GOALS_RESPONSE.rows.map((row) => ({ id: row.id, ref: row.ref, title: row.title }))
  )

  // The read asked for exactly this read: goals, active, the context, an explicit limit.
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.ok(request)
  const url = new URL(request.url)
  assert.equal(url.pathname, '/api/resources')
  assert.equal(url.searchParams.get('doc_type_name'), 'goal')
  assert.equal(url.searchParams.get('status'), 'active')
  assert.equal(url.searchParams.get('context_ref'), '@me/temper')
  assert.ok(url.searchParams.get('limit') !== null, 'the list call must carry an explicit limit')
  // … and the request rode the borrowed grant, not an anonymous or invented token.
  assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`)

  // One strategy per worker: a second read rides the cached token — no second export-token run.
  const again = await worker.request('temper.goals.active')
  assert.equal(again.connected, true)
  assert.equal(requests.length, 2)
  assert.equal(runs, 1, 'two reads, one mint: the cached token carried the second')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('reads at the origin the CLI is configured for when the setting is unset', async () => {
  const hadEnv = 'TEMPER_API_URL' in process.env
  const envValue = process.env.TEMPER_API_URL
  delete process.env.TEMPER_API_URL
  try {
    deps.run = async () => ({ code: 0, stdout: `${TOKEN}\n`, stderr: '' })
    deps.readTextFile = () => '[cloud]\napi_url = "https://temper-configured.example"\n'
    const requests: Request[] = []
    deps.fetch = async (input: Request) => {
      requests.push(input)
      return new Response(JSON.stringify(GOALS_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    const host = mockHost({ settings: { contextRef: '@me/temper' } })
    const worker = await mountWorker(main, { host })
    const answer = await worker.request('temper.goals.active')

    assert.equal(answer.connected, true)
    assert.equal(requests.length, 1)
    const request = requests[0]
    assert.ok(request)
    assert.equal(new URL(request.url).origin, 'https://temper-configured.example')
    await worker.deactivate()
  } finally {
    if (hadEnv) {
      process.env.TEMPER_API_URL = envValue
    }
  }
})
