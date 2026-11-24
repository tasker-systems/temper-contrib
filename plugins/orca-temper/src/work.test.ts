// The work records, worker side (decision ruling 26), over the host mock with deps.ts standing
// in for the temper CLI and API. Pinned here: Orca reporting a run done writes nothing to
// temper — only the press does; a double press writes once, whether the presses overlap or
// follow each other; a run working again is not offered to record; the record holds the
// shape's fields and nothing that reads as task state; Reopen from a record is offered and
// runs only for this Orca host's runs; and the launch sheet's claim is temper's open meta,
// read as temper holds it.
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assert, afterEach, mockHost, mountWorker, test } from 'orca/testing'
import { deps, type CommandResult } from './deps'
import type { LinkedRun } from './links'
import { isHere, machineHost, orcaHostOf, recordArgs, recordContent } from './work'
import { ORCA_OUTCOMES } from './work-protocol'
import * as main from './worker'

const originalDeps = { ...deps }
afterEach(() => {
  deps.run = originalDeps.run
  deps.fetch = originalDeps.fetch
  deps.machine = originalDeps.machine
})

const TASK_ID = '00000000-0000-7000-8000-0000000000f2'
const WS = { id: 'identity:wt:local:work', name: 'contrib · pt/work', branch: 'pt/work' }
const FINISHED_MS = Date.parse('2026-11-23T12:00:00.000Z')
const SCHEMA = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'schemas', 'orca-work.schema.json'), 'utf8')
) as { required: string[]; properties: Record<string, { pattern?: string; enum?: string[] }>; additionalProperties: boolean }

function fakeToken(): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'none' })}.${encode({ exp: 4_102_444_800 })}.sig`
}

interface FakeTemper {
  artifacts: Record<string, unknown>[]
  commits: string[][]
  openMeta: Record<string, unknown>
}

/** temper's grant, the task's artifacts and its open meta; commits are slow enough to overlap. */
function fakeTemper(): FakeTemper {
  const temper: FakeTemper = { artifacts: [], commits: [], openMeta: {} }
  deps.run = async (args): Promise<CommandResult> => {
    if (args[0] === 'auth' && args[1] === 'export-token') {
      return { code: 0, stdout: `${fakeToken()}\n`, stderr: '' }
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      return { code: 0, stdout: JSON.stringify({ api_url: 'https://temper.example' }), stderr: '' }
    }
    if (args[0] === 'data-artifact' && args[1] === 'commit') {
      temper.commits.push([...args])
      const file = (args[args.indexOf('--content') + 1] ?? '').slice(1)
      const content = JSON.parse(await readFile(file, 'utf8'))
      await new Promise((resolve) => setTimeout(resolve, 5))
      const artifact = {
        artifact_id: `00000000-0000-7000-8000-00000000b${String(temper.artifacts.length).padStart(3, '0')}`,
        resource_id: args[2],
        artifact_kind: args[args.indexOf('--kind') + 1],
        content,
        is_folded: false
      }
      temper.artifacts.push(artifact)
      return { code: 0, stdout: JSON.stringify(artifact), stderr: '' }
    }
    return { code: 1, stdout: '{"code":"UNEXPECTED"}', stderr: '' }
  }
  deps.fetch = async (input: Request) => {
    const url = new URL(input.url)
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.pathname === `/api/resources/${TASK_ID}/artifacts`) {
      return json(temper.artifacts.filter((artifact) => artifact.artifact_kind === url.searchParams.get('kind')))
    }
    if (url.pathname === `/api/resources/${TASK_ID}`) {
      return json({
        id: TASK_ID,
        ref: `t-${TASK_ID}`,
        title: 'T',
        doc_type_name: 'task',
        managed_meta: { 'temper-stage': 'done' },
        open_meta: temper.openMeta,
        owner_handle: 'o',
        updated: '2026-11-23T00:00:00Z'
      })
    }
    const byId = url.pathname.match(/^\/api\/data-artifacts\/([0-9a-f-]+)$/)
    if (byId !== null) {
      const artifact = temper.artifacts.find((entry) => entry.artifact_id === byId[1])
      return artifact === undefined ? new Response('{}', { status: 404 }) : json(artifact)
    }
    return new Response('{}', { status: 404 })
  }
  return temper
}

function linkedHost(extra: Record<string, unknown> = {}) {
  return mockHost({
    results: {
      'workspace.list': {
        workspaces: [{ id: WS.id, kind: 'worktree', name: WS.name, projectId: 'repo', path: '/w/work', branch: WS.branch, hostId: 'local' }],
        truncated: false
      },
      'agents.list': { agents: [] },
      'agent.resume': { terminalId: 't-back', started: true }
    },
    storage: {
      'launch-links': [
        {
          workspaceId: WS.id,
          itemId: TASK_ID,
          ref: `t-${TASK_ID}`,
          contextRef: '+team/c',
          startedAt: '2026-11-23T11:00:00.000Z',
          agent: 'claude',
          terminalId: 't-run',
          docType: 'task',
          ...extra
        }
      ]
    }
  })
}

const doneEvent = {
  workspaceId: 'repo::/w/work',
  workspaceListId: WS.id,
  paneKey: 'p',
  terminalId: 't-run',
  state: 'done' as const,
  receivedAt: FINISHED_MS,
  mainAgent: { state: 'done' as const, outcome: 'failure' as const, stateStartedAt: FINISHED_MS },
  sessionId: 'sess-work'
}

type Records = { state: string; records: { here: boolean; artifactId: string }[]; recordable: { workspaceId: string }[] }

test('a run ending writes nothing to temper; it only lights Record this work', async () => {
  const temper = fakeTemper()
  const worker = await mountWorker(main, { host: linkedHost() })
  await worker.emit('agent.status.changed', doneEvent)
  const answer = (await worker.request('temper.work.records', { itemId: TASK_ID })) as Records
  assert.equal(answer.state, 'ok')
  assert.deepEqual(answer.recordable.map((run) => run.workspaceId), [WS.id], 'the finished run is offered')
  assert.equal(temper.commits.length, 0, 'no record is written without the press')
  assert.equal(temper.artifacts.length, 0)
  await worker.deactivate()
})

test('a double press writes once — overlapping or one after the other', async () => {
  const temper = fakeTemper()
  const worker = await mountWorker(main, { host: linkedHost() })
  await worker.emit('agent.status.changed', doneEvent)
  const press = { itemId: TASK_ID, workspaceId: WS.id }
  const [first, second] = await Promise.all([
    worker.request('temper.work.record', press),
    worker.request('temper.work.record', press)
  ])
  assert.deepEqual([first.state, second.state].sort(), ['already-recorded', 'recorded'])
  const third = await worker.request('temper.work.record', press)
  assert.equal(third.state, 'already-recorded', 'a later press finds the run recorded')
  assert.equal(temper.commits.length, 1, 'one commit for the run')
  const after = (await worker.request('temper.work.records', { itemId: TASK_ID })) as Records
  assert.equal(after.records.length, 1)
  assert.deepEqual(after.recordable, [], 'a recorded run is not offered again')
  await worker.deactivate()
})

test('a record is committed as the person through the plugin UI: the Save persona, no model', async () => {
  const args = recordArgs(TASK_ID, '/tmp/x.json')
  assert.deepEqual(args.slice(0, 7), ['data-artifact', 'commit', TASK_ID, '--kind', 'orca-work', '--intent', 'member'])
  assert.equal(args[args.indexOf('--persona') + 1], 'orca-temper-ui')
  assert.ok(!args.includes('--model'), 'the person pressed it: no model is named')
})

test('a run working again is not offered to record until Orca reports it done again', async () => {
  fakeTemper()
  const worker = await mountWorker(main, { host: linkedHost() })
  await worker.emit('agent.status.changed', doneEvent)
  await worker.emit('agent.status.changed', { ...doneEvent, state: 'working', mainAgent: { state: 'working', stateStartedAt: FINISHED_MS + 10 } })
  const answer = (await worker.request('temper.work.records', { itemId: TASK_ID })) as Records
  assert.deepEqual(answer.recordable, [])
  const refused = await worker.request('temper.work.record', { itemId: TASK_ID, workspaceId: WS.id })
  assert.equal(refused.state, 'failed', 'nothing is recorded for a run still under way')
  await worker.deactivate()
})

test('the record holds the shape\'s fields and none that reads as task state', () => {
  const run: LinkedRun = {
    workspaceId: WS.id,
    name: WS.name,
    agent: 'codex',
    sessionId: 's-1',
    startedAt: '2026-11-23T11:00:00Z',
    finishedAt: '2026-11-23T12:00:00.000Z',
    outcome: 'success',
    branch: WS.branch,
    hostId: 'local'
  }
  const content = recordContent(run) as Record<string, unknown> | null
  assert.ok(content !== null)
  const declared = Object.keys(SCHEMA.properties)
  assert.equal(SCHEMA.additionalProperties, false, 'the vocabulary is closed')
  for (const key of Object.keys(content)) {
    assert.ok(declared.includes(key), `${key} is a declared field`)
  }
  for (const key of SCHEMA.required) {
    assert.ok(key in content, `${key} is present`)
  }
  for (const [key, spec] of Object.entries(SCHEMA.properties)) {
    const value = content[key]
    if (typeof value === 'string' && spec.pattern !== undefined) {
      assert.match(value, new RegExp(spec.pattern), `${key} matches its pattern`)
    }
  }
  assert.deepEqual(SCHEMA.properties.orca_outcome.enum, [...ORCA_OUTCOMES], 'one vocabulary for the outcome')
  const taskState = /status|stage|claim|heartbeat|state|progress|transcript|output|path/i
  for (const key of declared) {
    assert.ok(!taskState.test(key), `${key} names no task state, transcript or path`)
  }
  assert.ok(!Object.values(content).some((value) => value === '/w/work'), 'no filesystem path is recorded')
  assert.equal(recordContent({ ...run, finishedAt: null }), null, 'an unfinished run makes no record')
})

test('Reopen from a record is offered and runs only for this Orca host\'s runs', async () => {
  const temper = fakeTemper()
  deps.machine = () => 'machine-one'
  const elsewhere = orcaHostOf('local')
  deps.machine = () => 'machine-two'
  assert.ok(!isHere(elsewhere), 'another machine\'s host is not this one')
  assert.ok(isHere(machineHost()) && isHere(orcaHostOf('ssh:box')), 'this machine, local or through its ssh host')
  const record = (sessionId: string, host: string) => ({
    artifact_id: `00000000-0000-7000-8000-0000000000c${sessionId.slice(-1)}`,
    resource_id: TASK_ID,
    artifact_kind: 'orca-work',
    is_folded: false,
    content: {
      agent: 'claude',
      workspace_name: WS.name,
      branch: WS.branch,
      orca_session_id: sessionId,
      orca_host: host,
      started_at: '2026-11-22T10:00:00Z',
      finished_at: '2026-11-22T11:00:00Z',
      orca_outcome: 'success'
    }
  })
  temper.artifacts.push(record('s-1', elsewhere), record('s-2', machineHost()))
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [{ id: WS.id, kind: 'worktree', name: WS.name, projectId: 'repo', path: '/w', branch: WS.branch, hostId: 'local' }],
        truncated: false
      },
      'agent.resume': { terminalId: 't', started: true }
    }
  })
  const worker = await mountWorker(main, { host })
  const answer = (await worker.request('temper.work.records', { itemId: TASK_ID })) as Records
  const byId = Object.fromEntries(answer.records.map((entry) => [entry.artifactId, entry.here]))
  assert.equal(byId['00000000-0000-7000-8000-0000000000c1'], false)
  assert.equal(byId['00000000-0000-7000-8000-0000000000c2'], true)
  const refused = await worker.request('temper.work.reopen', { itemId: TASK_ID, artifactId: '00000000-0000-7000-8000-0000000000c1' })
  assert.equal(refused.state, 'failed')
  assert.deepEqual(host.callsOf('agent.resume'), [], 'another host\'s session is never resumed here')
  const reopened = await worker.request('temper.work.reopen', { itemId: TASK_ID, artifactId: '00000000-0000-7000-8000-0000000000c2' })
  assert.equal(reopened.state, 'reopened')
  assert.deepEqual(host.callsOf('agent.resume'), [{ workspaceId: WS.id, agent: 'claude', sessionId: 's-2' }])
  await worker.deactivate()
})

test('the launch sheet\'s claim is temper\'s open meta, as temper holds it', async () => {
  const temper = fakeTemper()
  const worker = await mountWorker(main, { host: linkedHost({ sessionId: 'sess-local', finishedAt: '2026-11-23T12:00:00.000Z', outcome: 'success' }) })
  assert.deepEqual(await worker.request('temper.task.claim', { id: TASK_ID }), { state: 'ok', claim: null }, 'a local link is no claim')
  temper.openMeta = { claim_id: 'c0ffee00-0000-4000-8000-000000000001', claimed_at: '2026-11-23T09:00:00Z', heartbeat_at: '2026-11-23T09:30:00Z' }
  assert.deepEqual(await worker.request('temper.task.claim', { id: TASK_ID }), {
    state: 'ok',
    claim: { claimId: 'c0ffee00-0000-4000-8000-000000000001', claimedAt: '2026-11-23T09:00:00Z', heartbeatAt: '2026-11-23T09:30:00Z' }
  })
  await worker.deactivate()
})

test('signed out, Record this work writes nothing and says temper is not connected', async () => {
  const temper = fakeTemper()
  const signedIn = deps.run
  deps.run = async (args) =>
    args[0] === 'auth' ? { code: 1, stdout: '{"code":"UNAUTHENTICATED"}', stderr: '' } : signedIn(args, process.env)
  const worker = await mountWorker(main, { host: linkedHost() })
  await worker.emit('agent.status.changed', doneEvent)
  const answer = await worker.request('temper.work.record', { itemId: TASK_ID, workspaceId: WS.id })
  assert.equal(answer.state, 'not-connected')
  assert.equal(temper.commits.length, 0)
  await worker.deactivate()
})
