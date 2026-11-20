// Worker tests over the orca host mock, with deps.ts standing in for the temper CLI and the
// network. The first test is the witness `orca_worker_refuses_without_the_persons_grant`:
// with the CLI answering non-zero (signed out) and the network WILLING to hand every group
// over, the worker must refuse on all three reads and return no group data.
import { assert, mockHost, mountWorker, test, afterEach } from 'orca/testing'
import { deps, type CommandResult, type RunCli } from './deps'
import * as main from './worker'

/** A syntactically valid unsigned JWT whose payload is just an `exp`. */
function fakeToken(expiresAtSeconds: number): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'none' })}.${encode({ exp: expiresAtSeconds })}.sig`
}

const TOKEN = fakeToken(4_102_444_800) // 2100-01-01, comfortably ahead of any run

/** A ResourceListResponse answering with two rows whenever the network is asked. */
interface ListFixture {
  facets: Record<string, never>
  limit: number
  offset: number
  returned: number
  truncated: boolean
  total: number
  rows: { id: string; ref: string; title: string; updated: string }[]
}

function listResponse(idLetters: 'a' | 'b', titles: [string, string]): ListFixture {
  const [first, second] = lettersFrom(idLetters)
  return {
    facets: {},
    limit: 1000,
    offset: 0,
    returned: 2,
    truncated: false,
    total: 2,
    rows: [
      { id: `00000000-0000-7000-8000-0000000000${first}a`, ref: `one-00000000-0000-7000-8000-0000000000${first}a`, title: titles[0], updated: '2026-01-01T00:00:00Z' },
      { id: `00000000-0000-7000-8000-0000000000${second}a`, ref: `two-00000000-0000-7000-8000-0000000000${second}a`, title: titles[1], updated: '2026-01-01T00:00:00Z' }
    ]
  }
}

function lettersFrom(letter: 'a' | 'b'): [string, string] {
  return letter === 'a' ? ['a1', 'a2'] : ['b1', 'b2']
}

const [GOALS_RESPONSE, TASKS_RESPONSE] = [
  listResponse('a', ['Goal one', 'Goal two']),
  listResponse('b', ['Task in progress one', 'Task in progress two'])
]

const SIGNED_OUT: CommandResult = {
  code: 1,
  stdout: '{"code":"UNAUTHENTICATED","message":"not signed in"}',
  stderr: 'export-token: token export is a privileged act\n'
}

/** The CLI's minted token; stderr carries its 15-line warning. */
function mintedToken(): CommandResult {
  return { code: 0, stdout: `${TOKEN}\n`, stderr: '' }
}

const originalDeps = { ...deps }
afterEach(() => {
  deps.run = originalDeps.run
  deps.fetch = originalDeps.fetch
})

/**
 * An auth-status answer in the confirmed shape. `api_url` reports what the CLI presents to;
 * never omitted, null only for an in-process client with no wire origin.
 */
function authStatus(apiUrl: string | unknown, extra: object = {}): CommandResult {
  return { code: 0, stdout: `${JSON.stringify({ ...extra, api_url: apiUrl })}\n`, stderr: '' }
}

/** A CLI answer dispatching by what was asked: the mint, or the origin question. */
function cliThatRuns(mint: CommandResult, status: CommandResult): RunCli {
  return async (args) =>
    args[0] === 'auth' && args[1] === 'status' ? status : mint
}

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
  for (const read of ['temper.goals.active', 'temper.tasks.in-progress', 'temper.handoff.latest'] as const) {
    const answer = await worker.request(read)
    if (answer.connected) {
      throw new Error(`${read} answered group data while the CLI is signed out`)
    }
    assert.match(answer.message, /temper is not connected/)
    // No group data rides the refusal — neither of the rows the network WOULD have returned.
    const serialized = JSON.stringify(answer)
    assert.equal(serialized.includes('Goal one'), false, `${read} carries no goal data`)
    assert.equal(serialized.includes('Goal two'), false, `${read} carries no goal data`)
    assert.equal(serialized.includes('00000000-0000-7000-8000'), false, `${read} carries no ids`)
  }
  // The refusals must come from consulting the credential strategy, not from guessing.
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
    return runs === 1 ? mintedToken() : SIGNED_OUT
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
  assert.deepEqual(answer.contexts, ['@me/temper'])
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

test('lists tasks in progress across the work contexts on the borrowed grant', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  // A different row set per context, so the merged answer shows both contexts' rows.
  const perContext: Record<string, ListFixture> = {
    '+temper-dev/contrib-workflows': TASKS_RESPONSE,
    '@me/temper': { facets: {}, limit: 1000, offset: 0, returned: 1, truncated: false, total: 1, rows: [TASKS_RESPONSE.rows[0]] }
  }
  deps.fetch = async (input: Request) => {
    requests.push(input)
    const contextRef = new URL(input.url).searchParams.get('context_ref')
    const fixture = contextRef !== null ? perContext[contextRef] : undefined
    assert.ok(fixture, `no fixture for the context asked (${contextRef})`)
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const host = mockHost({
    settings: {
      workContexts: '+temper-dev/contrib-workflows, @me/temper',
      contextRef: '@me/temper',
      apiUrl: 'https://temper.example'
    }
  })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.tasks.in-progress')

  assert.equal(answer.connected, true)
  if (!answer.connected) return
  // One request per context ref, in the setting's order, merged into one answer.
  assert.deepEqual(answer.contexts, ['+temper-dev/contrib-workflows', '@me/temper'])
  assert.deepEqual(
    answer.tasks,
    [...TASKS_RESPONSE.rows, TASKS_RESPONSE.rows[0]].map((row) => ({ id: row.id, ref: row.ref, title: row.title }))
  )
  assert.equal(requests.length, 2, 'one list request per work context')
  for (const [index, contextRef] of answer.contexts.entries()) {
    const request = requests[index]
    assert.ok(request)
    const url = new URL(request.url)
    assert.equal(url.pathname, '/api/resources')
    assert.equal(url.searchParams.get('doc_type_name'), 'task')
    assert.equal(url.searchParams.get('stage'), 'in-progress')
    assert.equal(url.searchParams.get('context_ref'), contextRef)
    assert.ok(url.searchParams.get('limit') !== null, 'the list call must carry an explicit limit')
    assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`)
  }
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

const NEWER_NOTE = {
  id: '00000000-0000-7000-8000-0000000000c3',
  ref: 'handoff-note-00000000-0000-7000-8000-0000000000c3',
  title: 'The latest session note',
  updated: '2026-11-20T01:00:00Z'
}
const OLDER_NOTE = {
  id: '00000000-0000-7000-8000-0000000000d4',
  ref: 'older-note-00000000-0000-7000-8000-0000000000d4',
  title: 'An older session note',
  updated: '2026-11-19T01:00:00Z'
}
const NOTES: Record<string, object> = {
  '@me/newer': { facets: {}, limit: 1, offset: 0, returned: 1, truncated: false, total: 2, rows: [NEWER_NOTE] },
  '+temper-dev/older': { facets: {}, limit: 1, offset: 0, returned: 1, truncated: false, total: 2, rows: [OLDER_NOTE] }
}
const NEWER_NOTE_BODY = [
  '# The latest session note',
  '',
  '## Learned',
  '',
  'The list endpoint filters on a single context ref.',
  '',
  '## Next steps',
  '',
  '- Record the witness runs',
  '- Run the live check'
].join('\n')

test('reads the latest handoff across the work contexts and its Next steps', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    requests.push(input)
    const url = new URL(input.url)
    if (url.pathname === '/api/resources') {
      const contextRef = url.searchParams.get('context_ref')
      const response = contextRef !== null ? NOTES[contextRef] : undefined
      assert.ok(response, `no fixture for the context asked (${contextRef})`)
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    // The body read takes a bare UUID and names the body section explicitly.
    assert.equal(url.pathname, `/api/resources/${NEWER_NOTE.id}`)
    assert.equal(url.searchParams.get('sections'), 'body')
    return new Response(JSON.stringify({ ...NEWER_NOTE, content: NEWER_NOTE_BODY }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const host = mockHost({
    settings: {
      workContexts: '@me/newer, +temper-dev/older',
      apiUrl: 'https://temper.example'
    }
  })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.handoff.latest')

  assert.equal(answer.connected, true)
  if (!answer.connected) return
  assert.deepEqual(answer.contexts, ['@me/newer', '+temper-dev/older'])
  // The newest note across both contexts won, by its updated time.
  assert.deepEqual(answer.handoff, {
    id: NEWER_NOTE.id,
    ref: NEWER_NOTE.ref,
    title: NEWER_NOTE.title,
    contextRef: '@me/newer',
    nextSteps: '- Record the witness runs\n- Run the live check'
  })
  assert.equal(answer.truncated, false)
  // Three requests: one one-row page per work context, then the winning note's body.
  assert.equal(requests.length, 3)
  for (const [index, contextRef] of answer.contexts.entries()) {
    const request = requests[index]
    assert.ok(request)
    const url = new URL(request.url)
    assert.equal(url.pathname, '/api/resources')
    assert.equal(url.searchParams.get('doc_type_name'), 'session')
    assert.equal(url.searchParams.get('sort'), 'updated')
    assert.equal(url.searchParams.get('order'), 'desc')
    assert.equal(url.searchParams.get('context_ref'), contextRef)
    assert.equal(url.searchParams.get('limit'), '1', 'the handoff page is one row, explicitly')
    assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`)
  }
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a handoff note with no Next steps answers none rather than inventing one', async () => {
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    const url = new URL(input.url)
    if (url.pathname === '/api/resources') {
      return new Response(
        JSON.stringify({ facets: {}, limit: 1, offset: 0, returned: 1, truncated: false, total: 1, rows: [NEWER_NOTE] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    return new Response(JSON.stringify({ ...NEWER_NOTE, content: '# The latest session note\n\nNo plan recorded here.' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const host = mockHost({ settings: { workContexts: '@me/newer', apiUrl: 'https://temper.example' } })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.handoff.latest')

  assert.equal(answer.connected, true)
  if (!answer.connected) return
  assert.notEqual(answer.handoff, null)
  assert.equal(answer.handoff?.nextSteps, null)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('reads at the origin temper auth status reports when the setting is unset', async () => {
  deps.run = cliThatRuns(mintedToken(), authStatus('https://cli-answered.example/'))
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
  // The origin the CLI answered with — trailing slash trimmed per its contract.
  assert.equal(new URL(request.url).origin, 'https://cli-answered.example')
  await worker.deactivate()
})

test('the API-origin setting overrides the CLI without asking it', async () => {
  let statusRuns = 0
  deps.run = async (args) => {
    if (args[0] === 'auth' && args[1] === 'status') {
      statusRuns += 1
    }
    return mintedToken()
  }
  deps.fetch = async () =>
    new Response(JSON.stringify(GOALS_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })

  const host = mockHost({
    settings: { contextRef: '@me/temper', apiUrl: 'https://setting.example' }
  })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.goals.active')

  assert.equal(answer.connected, true)
  assert.equal(statusRuns, 0, 'a set origin setting means the CLI is never asked')
  await worker.deactivate()
})

test('two reads, one mint, one status run — the token travels with its origin', async () => {
  let mints = 0
  let statuses = 0
  const origins: string[] = []
  deps.run = async (args) => {
    if (args[0] === 'auth' && args[1] === 'status') {
      statuses += 1
      return authStatus('https://cli-answered.example')
    }
    mints += 1
    return mintedToken()
  }
  deps.fetch = async (input: Request) => {
    origins.push(new URL(input.url).origin)
    return new Response(JSON.stringify(GOALS_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  // No apiUrl setting: the mint asks the status once, and the pair answers both reads.
  const host = mockHost({ settings: { contextRef: '@me/temper' } })
  const worker = await mountWorker(main, { host })
  const first = await worker.request('temper.goals.active')
  const second = await worker.request('temper.goals.active')

  assert.equal(first.connected, true)
  assert.equal(second.connected, true)
  assert.equal(mints, 1, 'two reads, one mint: the token is cached')
  assert.equal(statuses, 1, 'two reads, one status run: the origin rode the same mint')
  assert.deepEqual(origins, [
    'https://cli-answered.example',
    'https://cli-answered.example'
  ])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a CLI too old to report its origin refuses naming the temper needed', async () => {
  // An old CLI's status carries no api_url: the answer is the refusal in its own words —
  // never a guess at an instance.
  deps.run = cliThatRuns(mintedToken(), authStatus(undefined, { authenticated: true }))
  deps.fetch = async () => {
    throw new Error('the too-old refusal must come before any API read')
  }

  const host = mockHost({ settings: { contextRef: '@me/temper' } })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.goals.active')

  assert.equal(answer.connected, false)
  assert.match(answer.message, /too old/)
  assert.match(answer.message, /0\.6\.5/)
  assert.equal(/98de/.test(answer.message), false)
  assert.equal(JSON.stringify(answer).includes('Goal one'), false)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a CLI reporting api_url null refuses rather than guessing', async () => {
  deps.run = cliThatRuns(mintedToken(), authStatus(null))
  deps.fetch = async () => {
    throw new Error('the null-origin refusal must come before any API read')
  }

  const host = mockHost({ settings: { contextRef: '@me/temper' } })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.goals.active')

  assert.equal(answer.connected, false)
  assert.match(answer.message, /api_url null/)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('hands the host\'s granted capabilities to the panel', async () => {
  // The withheld case: the host granted settings:own only, exactly as Orca holds a declined
  // consent. The panel must see exactly that — the panel reads the consents off this answer,
  // and it is also the pass-through the capability-gating witness builds on.
  const host = mockHost({ capabilities: ['settings:own'] })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.capabilities')
  assert.deepEqual(answer.granted, ['settings:own'])
  await worker.deactivate()
})

test('every declared consent reads granted when the host holds none back', async () => {
  // mockHost defaults to the manifest's declared capabilities: the set the Q9 ruling declared
  // up front. With everything granted, the panel lights every action it draws.
  const worker = await mountWorker(main, { host: mockHost() })
  const answer = await worker.request('temper.capabilities')
  const expected = [
    'settings:own',
    'workspace:read',
    'workspace:create',
    'agent:launch',
    'agent:read',
    'storage:own',
    'workspace:write'
  ]
  for (const kind of expected) {
    assert.ok(answer.granted.includes(kind), `${kind} is among the granted`)
  }
  assert.equal(answer.granted.length, expected.length, 'the grant names nothing undeclared')
  await worker.deactivate()
})
