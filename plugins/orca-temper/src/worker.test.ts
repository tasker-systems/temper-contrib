// Worker tests over the orca host mock, with deps.ts standing in for the temper CLI and the
// network. The first test is the witness `orca_worker_refuses_without_the_persons_grant`:
// with the CLI answering non-zero (signed out) and the network WILLING to hand every region
// over, the worker must refuse on all of them — the Home reads, the record detail and a
// goal's linked tasks — and return no region data.
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

/** One list row, with what Home carries: the type word, its home, the times. */
interface RowFixture {
  id: string
  ref: string
  title: string
  doc_type_name: string
  context_ref: string | null
  updated: string
  changed_by_me_at?: string | null
  managed_meta?: Record<string, unknown> | null
}

/** A ResourceListResponse answering with the given rows. */
interface ListFixture {
  facets: Record<string, never>
  limit: number
  offset: number
  returned: number
  truncated: boolean
  total: number
  rows: RowFixture[]
}

function row(suffix: string, title: string, docType: string, extra: Partial<RowFixture> = {}): RowFixture {
  return {
    id: `00000000-0000-7000-8000-0000000000${suffix}`,
    ref: `row-00000000-0000-7000-8000-0000000000${suffix}`,
    title,
    doc_type_name: docType,
    context_ref: '+temper-dev/contrib',
    updated: '2026-11-20T01:00:00Z',
    ...extra
  }
}

function listResponse(rows: RowFixture[], total = rows.length): ListFixture {
  return {
    facets: {},
    limit: rows.length,
    offset: 0,
    returned: rows.length,
    truncated: rows.length < total,
    total,
    rows
  }
}

const GOAL_ROWS = [row('a1', 'Goal one', 'goal'), row('a2', 'Goal two', 'goal')]

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

/** A network answering any temper read with the goals list, watching what it is asked. */
function answering(fixture: unknown, requests: Request[]): (input: Request) => Promise<Response> {
  return async (input: Request) => {
    requests.push(input)
    return new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
}

const SIGNED_IN_SETTINGS = { apiUrl: 'https://temper.example' }

test('orca_worker_refuses_without_the_persons_grant', async () => {
  let runs = 0
  const requests: Request[] = []
  deps.run = async () => {
    runs += 1
    return SIGNED_OUT
  }
  deps.fetch = answering(listResponse(GOAL_ROWS), requests)

  const host = mockHost({ settings: SIGNED_IN_SETTINGS })
  const worker = await mountWorker(main, { host })
  const reads = [
    ['temper.home.resume', undefined],
    ['temper.home.handoff', undefined],
    ['temper.home.way-in', { id: 'goals', bound: 8 }],
    ['temper.home.way-in', { id: 'tasks', bound: 8 }],
    ['temper.home.way-in', { id: 'sessions', bound: 8 }],
    ['temper.home.places', undefined],
    ['temper.home.recent', undefined],
    ['temper.resource.detail', { id: '00000000-0000-7000-8000-0000000000a1' }],
    ['temper.goal.tasks', { id: '00000000-0000-7000-8000-0000000000a1', bound: 8 }],
    ['temper.handoff.tasks', { sessionId: '00000000-0000-7000-8000-0000000000a1' }]
  ] as const
  for (const [name, input] of reads) {
    const answer = await worker.request(name, input as never)
    if (answer.state === 'ok') {
      throw new Error(`${name} answered region data while the CLI is signed out`)
    }
    assert.equal(answer.state, 'not-connected', `${name} refuses as not connected`)
    assert.match(answer.message, /temper is not connected/)
    // No region data rides the refusal — neither of the rows the network WOULD have returned.
    const serialized = JSON.stringify(answer)
    assert.equal(serialized.includes('Goal one'), false, `${name} carries no goal data`)
    assert.equal(serialized.includes('00000000-0000-7000-8000'), false, `${name} carries no ids`)
  }
  // The refusals must come from consulting the credential strategy, not from guessing.
  assert.ok(runs > 0, 'the worker never asked the credential strategy for a token')
  assert.equal(requests.length, 0, 'signed out, the worker must not even ask the API')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('losing the grant mid-read is the same refusal', async () => {
  // The mint at the gate succeeds, the API refuses the token it presents, and the re-mint the
  // client tries discovers the CLI signed out — the answer is still the refusal, no region data.
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

  const host = mockHost({ settings: SIGNED_IN_SETTINGS })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.home.resume')

  assert.equal(answer.state, 'not-connected')
  assert.match(answer.state === 'not-connected' ? answer.message : '', /temper is not connected/)
  assert.equal(JSON.stringify(answer).includes('Goal one'), false)
  assert.equal(runs, 2, 'the gate minted once; the 401 re-mint found the CLI signed out')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test("resume is the one resource the person last changed, by their own change time", async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  const changed = row('c1', 'The design record', 'decision', {
    changed_by_me_at: '2026-11-20T02:00:00Z',
    updated: '2026-11-20T09:00:00Z'
  })
  deps.fetch = answering(listResponse([changed]), requests)

  const host = mockHost({ settings: SIGNED_IN_SETTINGS })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.home.resume')

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.notEqual(answer.resume, null)
  assert.equal(answer.resume?.resource.title, 'The design record')
  // The person's own change time, never `updated`, which a teammate's write moved after.
  assert.equal(answer.resume?.changedAt, '2026-11-20T02:00:00Z')

  const request = requests[0]
  assert.ok(request)
  const url = new URL(request.url)
  assert.equal(url.pathname, '/api/resources')
  assert.equal(url.searchParams.get('changed_by'), '@me')
  assert.equal(url.searchParams.get('sort'), 'changed_by_me')
  assert.equal(url.searchParams.get('order'), 'desc')
  assert.equal(url.searchParams.get('limit'), '1')
  assert.equal(url.searchParams.get('context_ref'), null, 'resume takes no context')
  assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('resume with no own change answers none, never an invented one', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  deps.fetch = answering(listResponse([]), requests)

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.home.resume')
  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.equal(answer.resume, null)
  await worker.deactivate()
})

test('a resume row without the change time fails the region rather than guessing', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  // `updated` moved by a teammate is no substitute: the region fails, naming what failed.
  deps.fetch = answering(listResponse([row('c2', 'Changed', 'task', { changed_by_me_at: null })]), requests)

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.home.resume')
  assert.equal(answer.state, 'failed')
  if (answer.state !== 'failed') return
  assert.match(answer.message, /change/)
  assert.equal(JSON.stringify(answer).includes('Changed'), false)
  await worker.deactivate()
})

test('a way in asks for its own filter on the person, at the panel bound', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  deps.fetch = answering(listResponse(GOAL_ROWS, 12), requests)

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.home.way-in', { id: 'goals', bound: 16 })

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.equal(answer.id, 'goals')
  assert.equal(answer.label, 'goals')
  assert.equal(answer.scope, 'active goals of yours')
  assert.equal(answer.bound, 16)
  assert.equal(answer.total, 12)
  assert.deepEqual(
    answer.rows.map((item) => item.title),
    ['Goal one', 'Goal two']
  )

  const request = requests[0]
  assert.ok(request)
  const url = new URL(request.url)
  assert.equal(url.pathname, '/api/resources')
  assert.equal(url.searchParams.get('doc_type_name'), 'goal')
  assert.equal(url.searchParams.get('owner'), '@me')
  assert.equal(url.searchParams.get('status'), 'active')
  assert.equal(url.searchParams.get('stage'), null, 'goals narrow by status, not stage')
  assert.equal(url.searchParams.get('sort'), 'updated')
  assert.equal(url.searchParams.get('order'), 'desc')
  assert.equal(url.searchParams.get('limit'), '16', 'the panel bound rides the call')
  assert.equal(url.searchParams.get('context_ref'), null, 'the ways in take no context')
  assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('each way in names its own workflow state', async () => {
  const queries: Record<string, string>[] = []
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    const url = new URL(input.url)
    queries.push(Object.fromEntries(url.searchParams.entries()))
    return new Response(JSON.stringify(listResponse([])), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  await worker.request('temper.home.way-in', { id: 'tasks', bound: 8 })
  await worker.request('temper.home.way-in', { id: 'sessions', bound: 8 })

  assert.equal(queries[0]?.doc_type_name, 'task')
  assert.equal(queries[0]?.stage, 'in-progress')
  assert.equal(queries[0]?.owner, '@me')
  assert.equal(queries[1]?.doc_type_name, 'session')
  assert.equal(queries[1]?.stage, undefined, 'sessions narrow by owner alone')
  assert.equal(queries[1]?.status, undefined)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('each status toggle sends its own stage or status, always on the person', async () => {
  const queries: Record<string, string>[] = []
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    const url = new URL(input.url)
    queries.push(Object.fromEntries(url.searchParams.entries()))
    return new Response(JSON.stringify(listResponse([], 3)), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const asks = [
    { id: 'tasks', status: 'backlog', key: 'stage', scope: 'backlog tasks of yours' },
    { id: 'tasks', status: 'in-progress', key: 'stage', scope: 'tasks in progress of yours' },
    { id: 'tasks', status: 'done', key: 'stage', scope: 'done tasks of yours' },
    { id: 'goals', status: 'active', key: 'status', scope: 'active goals of yours' },
    { id: 'goals', status: 'completed', key: 'status', scope: 'completed goals of yours' }
  ]
  for (const [index, ask] of asks.entries()) {
    const answer = await worker.request('temper.home.way-in', { id: ask.id, bound: 8, status: ask.status })
    assert.equal(answer.state, 'ok')
    if (answer.state !== 'ok') return
    assert.equal(answer.status, ask.status, 'the answer names the status it was read by')
    assert.equal(answer.scope, ask.scope, 'the omission words follow the status')
    assert.equal(answer.total, 3)
    const query = queries[index]
    assert.equal(query?.owner, '@me', `${ask.id} by ${ask.status} keeps the person's scope`)
    assert.equal(query?.[ask.key], ask.status, `${ask.id} by ${ask.status} narrows on its ${ask.key}`)
    const other = ask.key === 'stage' ? 'status' : 'stage'
    assert.equal(query?.[other], undefined, `${ask.id} never narrows on its ${other}`)
    assert.equal(query?.doc_type_name, ask.id === 'tasks' ? 'task' : 'goal')
    assert.equal(query?.limit, '8')
  }
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a way read with no status reads its WAYS_IN default and names it', async () => {
  deps.run = async () => mintedToken()
  deps.fetch = answering(listResponse([]), [])
  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const tasks = await worker.request('temper.home.way-in', { id: 'tasks', bound: 8 })
  const goals = await worker.request('temper.home.way-in', { id: 'goals', bound: 8 })
  const sessions = await worker.request('temper.home.way-in', { id: 'sessions', bound: 8 })
  assert.equal(tasks.state === 'ok' && tasks.status, 'in-progress')
  assert.equal(goals.state === 'ok' && goals.status, 'active')
  assert.equal(sessions.state === 'ok' && sessions.status, null, 'sessions take no toggle')
  await worker.deactivate()
})

test('a status a way does not offer is the caller\'s error, not a read', async () => {
  deps.run = async () => mintedToken()
  const requests: Request[] = []
  deps.fetch = answering(listResponse([]), requests)
  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  for (const ask of [
    { id: 'goals', status: 'backlog' },
    { id: 'tasks', status: 'active' },
    { id: 'sessions', status: 'done' }
  ]) {
    const answer = await worker.request('temper.home.way-in', { ...ask, bound: 8 })
    assert.equal(answer.state, 'failed', `${ask.id} by ${ask.status}`)
    if (answer.state !== 'failed') return
    assert.match(answer.message, /offers no/)
  }
  assert.equal(requests.length, 0)
  await worker.deactivate()
})

test('a way-in id WAYS_IN does not name is the caller\'s error, not a read', async () => {
  deps.run = async () => mintedToken()
  const requests: Request[] = []
  deps.fetch = answering(listResponse([]), requests)

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.home.way-in', { id: 'everything', bound: 8 })
  assert.equal(answer.state, 'failed')
  if (answer.state !== 'failed') return
  assert.match(answer.message, /unknown way in/)
  assert.equal(requests.length, 0)
  await worker.deactivate()
})

const NOTE = row('d4', 'The latest session note', 'session')
const NOTE_BODY = [
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

test('the latest handoff is the person\'s newest session, its Next section quoted', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    requests.push(input)
    const url = new URL(input.url)
    if (url.pathname === '/api/resources') {
      return new Response(JSON.stringify(listResponse([NOTE], 4)), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    // The body read takes a bare UUID and names the body section explicitly.
    assert.equal(url.pathname, `/api/resources/${NOTE.id}`)
    assert.equal(url.searchParams.get('sections'), 'body')
    return new Response(JSON.stringify({ ...NOTE, content: NOTE_BODY }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.home.handoff')

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.equal(answer.sessionCount, 4)
  assert.deepEqual(answer.handoff, {
    id: NOTE.id,
    ref: NOTE.ref,
    title: NOTE.title,
    contextRef: NOTE.context_ref,
    next: { heading: 'Next steps', text: '- Record the witness runs\n- Run the live check', truncated: false }
  })
  const list = new URL(requests[0]?.url ?? '')
  assert.equal(list.searchParams.get('doc_type_name'), 'session')
  assert.equal(list.searchParams.get('owner'), '@me')
  assert.equal(list.searchParams.get('sort'), 'updated')
  assert.equal(list.searchParams.get('order'), 'desc')
  assert.equal(list.searchParams.get('limit'), '1', 'the handoff page is one row, explicitly')
  assert.equal(requests.length, 2, 'one one-row page, then the winning note\'s body')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a handoff note with no Next section answers none rather than inventing one', async () => {
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    const url = new URL(input.url)
    if (url.pathname === '/api/resources') {
      return new Response(JSON.stringify(listResponse([NOTE])), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response(
      JSON.stringify({ ...NOTE, content: '# The latest session note\n\nNo plan recorded here.' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.home.handoff')

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.notEqual(answer.handoff, null)
  assert.equal(answer.handoff?.next, null)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('recently updated covers everything readable, five rows, newest first', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  const rows = [
    row('e1', 'A task', 'task', { managed_meta: { 'temper-stage': 'in-progress' } }),
    row('e2', 'A cogmap fact', 'fact', { context_ref: null }),
    row('e3', 'A goal', 'goal', { managed_meta: { 'temper-status': 'active', 'temper-stage': '' } })
  ]
  deps.fetch = answering(listResponse(rows, 40), requests)

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.home.recent')

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.equal(answer.total, 40)
  assert.deepEqual(
    answer.rows.map((item) => [item.title, item.docType, item.contextRef, item.stage]),
    [
      ['A task', 'task', '+temper-dev/contrib', 'in-progress'],
      ['A cogmap fact', 'fact', null, null],
      ['A goal', 'goal', '+temper-dev/contrib', 'active']
    ],
    'a row carries its stage, else its status, from the managed meta the list answers'
  )
  const url = new URL(requests[0]?.url ?? '')
  assert.equal(url.searchParams.get('sort'), 'updated')
  assert.equal(url.searchParams.get('order'), 'desc')
  assert.equal(url.searchParams.get('limit'), '5')
  assert.equal(url.searchParams.get('owner'), null, 'recent names no owner — everything readable')
  assert.equal(url.searchParams.get('context_ref'), null)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

const CONTEXTS = [
  {
    id: '11111111-1111-7111-8111-111111111111',
    name: 'contrib-workflows',
    slug: 'contrib-workflows',
    owner_ref: '+temper-dev',
    can_write: true,
    retired: false,
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    kb_owner_id: '22222222-2222-7222-8222-222222222222',
    kb_owner_table: 'kb_teams',
    resource_count: 3
  },
  {
    id: '33333333-3333-7333-8333-333333333333',
    name: 'contrib',
    slug: 'contrib',
    owner_ref: '+temper-dev',
    can_write: false,
    retired: false,
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    kb_owner_id: '22222222-2222-7222-8222-222222222222',
    kb_owner_table: 'kb_teams',
    resource_count: 9
  }
]

test('places are the contexts the person changed something in, by their own latest change', async () => {
  const requests: string[] = []
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    const url = new URL(input.url)
    requests.push(url.pathname)
    if (url.pathname === '/api/me/context-activity') {
      return new Response(
        JSON.stringify([
          { context_id: CONTEXTS[1]?.id, last_changed_at: '2026-11-20T03:00:00Z' },
          { context_id: CONTEXTS[0]?.id, last_changed_at: '2026-11-19T03:00:00Z' },
          // A place the contexts read does not name is dropped — an unnamed row cannot be followed.
          { context_id: '99999999-9999-7999-8999-999999999999', last_changed_at: '2026-11-20T06:00:00Z' }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    assert.equal(url.pathname, '/api/contexts')
    return new Response(JSON.stringify(CONTEXTS), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.home.places')

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  // Newest change of the person's own first — not the context's `updated`, and the unnameable
  // place is out.
  assert.deepEqual(
    answer.rows.map((place) => [place.ref, place.name, place.lastChangedAt]),
    [
      ['+temper-dev/contrib', 'contrib', '2026-11-20T03:00:00Z'],
      ['+temper-dev/contrib-workflows', 'contrib-workflows', '2026-11-19T03:00:00Z']
    ]
  )
  assert.equal(answer.total, 2)
  assert.deepEqual(requests.sort(), ['/api/contexts', '/api/me/context-activity'])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a failed read is that region\'s failure beside the others, naming what failed', async () => {
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    const url = new URL(input.url)
    if (url.pathname === '/api/me/context-activity') {
      return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'db gone' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response(JSON.stringify(listResponse(GOAL_ROWS)), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const places = await worker.request('temper.home.places')
  const goals = await worker.request('temper.home.way-in', { id: 'goals', bound: 8 })

  assert.equal(places.state, 'failed')
  if (places.state !== 'failed') return
  assert.match(places.message, /places/)
  assert.equal(JSON.stringify(places).includes('Goal one'), false)
  assert.equal(goals.state, 'ok', 'the failure does not fall on the region that answered')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('reads at the origin temper auth status reports when the setting is unset', async () => {
  deps.run = cliThatRuns(mintedToken(), authStatus('https://cli-answered.example/'))
  const requests: Request[] = []
  deps.fetch = answering(listResponse([]), requests)

  const host = mockHost({ settings: {} })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.home.resume')

  assert.equal(answer.state, 'ok')
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
  deps.fetch = answering(listResponse([]), [])

  const host = mockHost({ settings: SIGNED_IN_SETTINGS })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.home.resume')

  assert.equal(answer.state, 'ok')
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
    return new Response(JSON.stringify(listResponse([])), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  // No apiUrl setting: the mint asks the status once, and the pair answers both reads.
  const host = mockHost({ settings: {} })
  const worker = await mountWorker(main, { host })
  const first = await worker.request('temper.home.resume')
  const second = await worker.request('temper.home.recent')

  assert.equal(first.state, 'ok')
  assert.equal(second.state, 'ok')
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

  const host = mockHost({ settings: {} })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.home.resume')

  assert.equal(answer.state, 'not-connected')
  if (answer.state !== 'not-connected') return
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

  const host = mockHost({ settings: {} })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('temper.home.resume')

  assert.equal(answer.state, 'not-connected')
  if (answer.state !== 'not-connected') return
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

/** A ResourceView answering the single-record door, as `sections` omitted arrives. */
const RECORD_ID = '44444444-4444-7444-8444-444444444444'
const GOAL_DETAIL_ID = '55555555-5555-7555-8555-555555555555'
const RECORD_VIEW = {
  id: RECORD_ID,
  ref: `the-item-detail-${RECORD_ID}`,
  title: 'The item detail',
  doc_type_name: 'task',
  created: '2026-11-01T00:00:00Z',
  updated: '2026-11-20T01:00:00Z',
  is_active: true,
  origin_uri: '',
  originator_profile_id: '019d0000-0000-7000-8000-000000000000',
  owner_profile_id: '019d0000-0000-7000-8000-000000000000',
  owner_handle: 'fixture-owner',
  context_name: 'contrib',
  context_owner_ref: '+temper-dev',
  context_slug: 'contrib',
  context_ref: '+temper-dev/contrib',
  cogmap_name: null,
  managed_meta: {
    'temper-stage': 'in-progress',
    'temper-mode': 'build',
    'temper-effort': 'small',
    'temper-llm-model': 'claude-opus-5-5',
    'temper-provenance': 'llm-discovered'
  }
}

test('the record read takes a bare UUID, asks no sections, and orders the meta as temper-ui does', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    requests.push(input)
    return new Response(JSON.stringify(RECORD_VIEW), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.resource.detail', { id: RECORD_ID })

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.equal(answer.detail.id, RECORD_ID)
  assert.equal(answer.detail.title, 'The item detail')
  assert.equal(answer.detail.ref, RECORD_VIEW.ref)
  assert.equal(answer.detail.docType, 'task')
  // doc_type first, the managed run in temper-ui's ranked order — stage, mode, effort,
  // then the provenance ranks — then the record's context, owner and updated. No body row,
  // and no content field crossed the read at all.
  assert.deepEqual(
    answer.detail.properties.map((each) => [each.label, each.value]),
    [
      ['doc_type', 'task'],
      ['temper-stage', 'in-progress'],
      ['temper-mode', 'build'],
      ['temper-effort', 'small'],
      ['temper-llm-model', 'claude-opus-5-5'],
      ['temper-provenance', 'llm-discovered'],
      ['context', '+temper-dev/contrib'],
      ['owner', 'fixture-owner'],
      ['updated', '2026-11-20T01:00:00Z']
    ]
  )

  const request = requests[0]
  assert.ok(request)
  const url = new URL(request.url)
  assert.equal(url.pathname, `/api/resources/${RECORD_ID}`)
  assert.equal(url.search, '', 'the record read asks for nothing — no sections, no body')
  assert.equal(request.method, 'GET', 'the record read is a read')
  assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`)
  assert.equal(requests.length, 1, 'one read answers the detail; no body read follows')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('an unranked managed key sorts after the ranked run, alphabetically', async () => {
  deps.run = async () => mintedToken()
  deps.fetch = async () =>
    new Response(
      JSON.stringify({
        ...RECORD_VIEW,
        managed_meta: { ...RECORD_VIEW.managed_meta, 'temper-legacy': 'kept' }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.resource.detail', { id: RECORD_ID })
  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  const labels = answer.detail.properties.map((each) => each.label)
  assert.equal(labels[0], 'doc_type')
  assert.equal(labels.at(-3), 'context')
  assert.equal(labels.at(-2), 'owner')
  assert.equal(labels.at(-1), 'updated')
  assert.deepEqual(labels.slice(1, -3), [
    'temper-stage',
    'temper-mode',
    'temper-effort',
    'temper-llm-model',
    'temper-provenance',
    'temper-legacy'
  ])
  await worker.deactivate()
})

test('a record homed nowhere (a cogmap) shows no context row, and none is invented', async () => {
  deps.run = async () => mintedToken()
  deps.fetch = async () =>
    new Response(JSON.stringify({ ...RECORD_VIEW, context_ref: null, cogmap_name: 'the map' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.resource.detail', { id: RECORD_ID })
  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.equal(
    answer.detail.properties.some((each) => each.label === 'context'),
    false,
    'no context row answers for a cogmap-homed record'
  )
  await worker.deactivate()
})

test('a decorated ref is the caller\'s error on the record door, never a read', async () => {
  deps.run = async () => mintedToken()
  const requests: Request[] = []
  deps.fetch = answering(listResponse([]), requests)

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.resource.detail', {
    id: 'the-item-detail-44444444-4444-7444-8444-444444444444'
  })
  assert.equal(answer.state, 'failed')
  if (answer.state !== 'failed') return
  assert.match(answer.message, /bare UUID/)
  assert.equal(requests.length, 0)
  await worker.deactivate()
})

test('a detail read into a refused grant is the signed-out refusal, no item data', async () => {
  // The mint at the gate succeeds; the API refuses the token on the detail read; the re-mint
  // finds the CLI signed out. The detail answers the refusal — the record's title never rides it.
  let runs = 0
  deps.run = async () => {
    runs += 1
    return runs === 1 ? mintedToken() : SIGNED_OUT
  }
  deps.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'bad token' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.resource.detail', { id: RECORD_ID })

  assert.equal(answer.state, 'not-connected')
  if (answer.state !== 'not-connected') return
  assert.match(answer.message, /temper is not connected/)
  assert.equal(JSON.stringify(answer).includes('The item detail'), false)
  assert.equal(runs, 2, 'the gate minted once; the 401 re-mint found the CLI signed out')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

const LINKED_ROWS = [row('b1', 'Task one', 'task'), row('b2', 'Task two', 'task')]

test('a goal\'s linked tasks are the advances edges, at the explicit bound', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  deps.fetch = answering(listResponse(LINKED_ROWS, 9), requests)

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.goal.tasks', { id: GOAL_DETAIL_ID, bound: 8 })

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.equal(answer.total, 9)
  assert.equal(answer.bound, 8)
  assert.deepEqual(
    answer.rows.map((item) => item.title),
    ['Task one', 'Task two']
  )

  const request = requests[0]
  assert.ok(request)
  const url = new URL(request.url)
  assert.equal(url.pathname, '/api/resources')
  assert.equal(url.searchParams.get('doc_type_name'), 'task')
  assert.equal(url.searchParams.get('goal'), GOAL_DETAIL_ID)
  assert.equal(url.searchParams.get('limit'), '8', 'the list door is asked at an explicit limit')
  assert.equal(url.searchParams.get('owner'), null, 'the ruled query names no owner')
  assert.equal(url.searchParams.get('status'), null)
  assert.equal(url.searchParams.get('stage'), null)
  assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a goal ref that is not a bare UUID is the caller\'s error, never a read', async () => {
  deps.run = async () => mintedToken()
  const requests: Request[] = []
  deps.fetch = answering(listResponse([]), requests)

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.goal.tasks', {
    id: 'goal-55555555-5555-7555-8555-555555555555',
    bound: 8
  })
  assert.equal(answer.state, 'failed')
  if (answer.state !== 'failed') return
  assert.match(answer.message, /bare UUID/)
  assert.equal(requests.length, 0)
  await worker.deactivate()
})

// Review 1: a task's prompt quotes the task's OWN latest linked session — the session→task
// `advances` edge — never the person's newest session. The read walks the task's connections
// for incoming advances rows, scopes sessions by those ids, and quotes the newest's Next.
const TASK_FOR_HANDOFF = '66666666-6666-7666-8666-666666666666'
const LINKED_SESSION = row('c1', 'The task session', 'session')
const FAR_SESSION = row('c2', 'The other task session', 'session')

/** One connections page for the task: two advancing sessions, plus the task's goal edge. */
function connectionsPage(ids: string[]) {
  return {
    limit: 200,
    returned: ids.length + 1,
    truncated: false,
    total: ids.length + 1,
    rows: [
      ...ids.map((peerId) => ({
        edge_id: `eeeeeeee-0000-7000-8000-000000000${peerId.slice(-2)}`,
        edge_kind: 'leads_to',
        label: 'advances',
        direction: 'incoming',
        polarity: 'forward',
        peer_table: 'kb_resources',
        peer_id: peerId,
        peer_slug: `peer-${peerId}`,
        peer_title: 'a linked session',
        weight: 1,
        created: '2026-11-20T01:00:00Z'
      })),
      {
        edge_id: 'eeeeeeee-0000-7000-8000-0000000000f0',
        edge_kind: 'leads_to',
        label: 'advances',
        direction: 'outgoing',
        polarity: 'forward',
        peer_table: 'kb_resources',
        peer_id: GOAL_DETAIL_ID,
        peer_slug: 'the-goal',
        peer_title: 'The goal',
        weight: 1,
        created: '2026-11-20T00:00:00Z'
      }
    ]
  }
}

test('a task\'s handoff is its own newest linked session, never the person\'s latest', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    requests.push(input)
    const url = new URL(input.url)
    if (url.pathname === `/api/resources/${TASK_FOR_HANDOFF}/connections`) {
      return new Response(JSON.stringify(connectionsPage([LINKED_SESSION.id, FAR_SESSION.id])), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (url.pathname === '/api/resources') {
      // The ids scope: ONLY the task's advancing sessions, never a person-wide newest.
      assert.equal(url.searchParams.get('ids'), `${LINKED_SESSION.id},${FAR_SESSION.id}`)
      assert.equal(url.searchParams.get('doc_type_name'), 'session')
      return new Response(JSON.stringify(listResponse([LINKED_SESSION], 2)), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    assert.equal(url.pathname, `/api/resources/${LINKED_SESSION.id}`)
    assert.equal(url.searchParams.get('sections'), 'body')
    return new Response(
      JSON.stringify({ ...LINKED_SESSION, content: '# The task session\n\n## Next steps\n\n- Land the launcher gates\n' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.launch.task-handoff', { id: TASK_FOR_HANDOFF })

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.equal(answer.handoff?.id, LINKED_SESSION.id)
  assert.equal(answer.handoff?.next?.text, '- Land the launcher gates')
  const list = new URL(requests[1]?.url ?? '')
  assert.equal(list.searchParams.get('limit'), '1')
  assert.equal(list.searchParams.get('sort'), 'updated')
  assert.equal(list.searchParams.get('owner'), null, 'no person scope rides a task\'s handoff')
  assert.equal(requests.length, 3, 'connections, the scoped session pick, the body')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a task with no advancing session has no handoff — and no list or body read follows', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    requests.push(input)
    return new Response(JSON.stringify(connectionsPage([])), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.launch.task-handoff', { id: TASK_FOR_HANDOFF })

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.equal(answer.handoff, null, 'nothing is quoted or invented')
  assert.equal(requests.length, 1, 'only the connections read ran')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

// Decision ruling 28: the handoff card names the tasks its session advanced — the session's
// OUTGOING `advances` edges — each with its stage as temper holds it, read on the list door.
const HANDOFF_SESSION = '77777777-7777-7777-8777-777777777777'
const ADVANCED_TASK = row('d1', 'The advanced task', 'task', { managed_meta: { 'temper-stage': 'done' } })

/** The session's connections: its task (outgoing), its goal (outgoing), and an incoming edge. */
function sessionConnections() {
  const edge = (peerId: string, direction: string, label = 'advances') => ({
    edge_id: `eeeeeeee-0000-7000-8000-0000000000${peerId.slice(-2)}`,
    edge_kind: 'leads_to',
    label,
    direction,
    polarity: 'forward',
    peer_table: 'kb_resources',
    peer_id: peerId,
    peer_slug: `peer-${peerId}`,
    peer_title: 'a peer',
    weight: 1,
    created: '2026-11-20T01:00:00Z'
  })
  const rows = [
    edge(ADVANCED_TASK.id, 'outgoing'),
    edge(GOAL_DETAIL_ID, 'outgoing'),
    edge('00000000-0000-7000-8000-0000000000e9', 'incoming'),
    edge('00000000-0000-7000-8000-0000000000e8', 'outgoing', 'cites')
  ]
  return { limit: 200, returned: rows.length, truncated: false, total: rows.length, rows }
}

test('the tasks a session advanced: its outgoing advances edges, each with its stage from temper', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    requests.push(input)
    const url = new URL(input.url)
    if (url.pathname === `/api/resources/${HANDOFF_SESSION}/connections`) {
      return new Response(JSON.stringify(sessionConnections()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    assert.equal(url.pathname, '/api/resources')
    // Only the outgoing advances peers, scoped to tasks — the goal edge is not a task.
    assert.equal(url.searchParams.get('ids'), `${ADVANCED_TASK.id},${GOAL_DETAIL_ID}`)
    assert.equal(url.searchParams.get('doc_type_name'), 'task')
    assert.ok(url.searchParams.get('limit'), 'an explicit limit rides the list call')
    return new Response(JSON.stringify(listResponse([ADVANCED_TASK])), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.handoff.tasks', { sessionId: HANDOFF_SESSION })

  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.deepEqual(
    answer.tasks.map((task) => [task.id, task.title, task.stage]),
    [[ADVANCED_TASK.id, 'The advanced task', 'done']],
    'the stage is the one temper answered'
  )
  assert.equal(requests.length, 2, 'the connections, then the scoped task read')
  assert.ok(requests.every((request) => request.method === 'GET'), 'nothing is written')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a session that advanced no task answers none — and no list read follows', async () => {
  const requests: Request[] = []
  deps.run = async () => mintedToken()
  deps.fetch = async (input: Request) => {
    requests.push(input)
    return new Response(JSON.stringify({ limit: 200, returned: 0, truncated: false, total: 0, rows: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.handoff.tasks', { sessionId: HANDOFF_SESSION })
  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.deepEqual(answer.tasks, [])
  assert.equal(requests.length, 1)
  await worker.deactivate()
})

test('a failed connections read is the read\'s failure, never an empty list', async () => {
  deps.run = async () => mintedToken()
  deps.fetch = async () =>
    new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    })
  const worker = await mountWorker(main, { host: mockHost({ settings: SIGNED_IN_SETTINGS }) })
  const answer = await worker.request('temper.handoff.tasks', { sessionId: HANDOFF_SESSION })
  assert.equal(answer.state, 'failed')
  if (answer.state !== 'failed') return
  assert.match(answer.message, /session's connections/)
  await worker.deactivate()
})
