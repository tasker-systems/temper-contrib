// The witness `orca_work_is_findable_from_its_task`, for the clause
// `orca-work-is-findable-from-temper`: after a linked agent's run finishes and the person presses
// Record this work, the task's artifacts in temper hold one `orca-work` record with the run's
// coordinates; and with the plugin's storage cleared — no workspace ↔ task link left on this
// machine — the task's records still lead back to the session, and Reopen agent resumes it in
// Orca. It drives the worker as Orca and temper would: Orca reports the run's end through
// `agent.status.changed` for the launch's own terminal, the temper CLI and API are one small
// fake that keeps what is committed, and a second worker on an empty storage stands for the
// plugin after its storage was cleared. This file imports nothing of the plugin's but the
// worker and its outside-world seam, so the same file runs against a worker without the
// mechanism and fails there.
import { readFile } from 'node:fs/promises'
import { assert, afterEach, mockHost, mountWorker, test } from 'orca/testing'
import { deps, type CommandResult } from './deps'
import * as main from './worker'

const originalDeps = { ...deps }
afterEach(() => {
  deps.run = originalDeps.run
  deps.fetch = originalDeps.fetch
})

const TASK_ID = '00000000-0000-7000-8000-0000000000f1'
const TASK_REF = `the-recorded-task-${TASK_ID}`
const WORKSPACE = { id: 'identity:wt:local:recorded', name: 'contrib · pt/recorded', branch: 'pt/recorded' }
const STARTED_AT = '2026-11-23T10:00:00.000Z'
const FINISHED_MS = Date.parse('2026-11-23T11:30:00.000Z')

function fakeToken(): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${encode({ alg: 'none' })}.${encode({ exp: 4_102_444_800 })}.sig`
}

/** temper, as far as this witness needs it: the grant, and the artifacts committed to the task. */
function fakeTemper(): { artifacts: Record<string, unknown>[] } {
  const artifacts: Record<string, unknown>[] = []
  deps.run = async (args): Promise<CommandResult> => {
    if (args[0] === 'auth' && args[1] === 'export-token') {
      return { code: 0, stdout: `${fakeToken()}\n`, stderr: '' }
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      return { code: 0, stdout: JSON.stringify({ api_url: 'https://temper.example' }), stderr: '' }
    }
    if (args[0] === 'data-artifact' && args[1] === 'commit') {
      const content = args[args.indexOf('--content') + 1] ?? ''
      const kind = args[args.indexOf('--kind') + 1]
      const artifact = {
        artifact_id: `00000000-0000-7000-8000-00000000a${String(artifacts.length).padStart(3, '0')}`,
        resource_id: args[2],
        artifact_kind: kind,
        intent: args[args.indexOf('--intent') + 1],
        content: JSON.parse(await readFile(content.slice(1), 'utf8')),
        content_bytes: 1,
        content_hash: 'h',
        created: new Date().toISOString(),
        is_folded: false,
        kind_owner_table: 'kb_profiles',
        kind_owner_id: '00000000-0000-7000-8000-0000000000aa',
        precedence: 0,
        shape_state: 'declared_satisfied'
      }
      artifacts.push(artifact)
      return { code: 0, stdout: JSON.stringify(artifact), stderr: '' }
    }
    return { code: 1, stdout: JSON.stringify({ code: 'UNEXPECTED', message: args.join(' ') }), stderr: '' }
  }
  deps.fetch = async (input: Request) => {
    const url = new URL(input.url)
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.pathname === `/api/resources/${TASK_ID}/artifacts`) {
      const kind = url.searchParams.get('kind')
      return json(artifacts.filter((artifact) => kind === null || artifact.artifact_kind === kind))
    }
    const byId = url.pathname.match(/^\/api\/data-artifacts\/([0-9a-f-]+)$/)
    if (byId !== null) {
      const artifact = artifacts.find((entry) => entry.artifact_id === byId[1])
      return artifact === undefined ? new Response('{}', { status: 404 }) : json(artifact)
    }
    return new Response(JSON.stringify({ code: 'NOT_FOUND', message: url.pathname }), { status: 404 })
  }
  return { artifacts }
}

function orcaHost(storage: Record<string, unknown>) {
  return mockHost({
    results: {
      'workspace.list': {
        workspaces: [
          { id: WORKSPACE.id, kind: 'worktree', name: WORKSPACE.name, projectId: 'repo-1', path: '/w/recorded', branch: WORKSPACE.branch, hostId: 'local' }
        ],
        truncated: false
      },
      'agents.list': { agents: [] },
      'agent.resume': { terminalId: 't-back', started: true }
    },
    storage: storage as never
  })
}

test('orca_work_is_findable_from_its_task', async () => {
  const temper = fakeTemper()

  // A Start press linked the workspace to the task; Orca named the session in the launch's terminal.
  const first = orcaHost({
    'launch-links': [
      {
        workspaceId: WORKSPACE.id,
        itemId: TASK_ID,
        ref: TASK_REF,
        contextRef: '+team/workflows',
        startedAt: STARTED_AT,
        agent: 'claude',
        terminalId: 't-run',
        docType: 'task',
        projectId: 'repo-1',
        path: '/w/recorded'
      }
    ]
  })
  const worker = await mountWorker(main, { host: first })

  // The run ends: Orca reports it for the launch's own terminal.
  await worker.emit('agent.status.changed', {
    workspaceId: 'repo-1::/w/recorded',
    workspaceListId: WORKSPACE.id,
    paneKey: 'pane-1',
    terminalId: 't-run',
    state: 'done',
    receivedAt: FINISHED_MS + 5,
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: FINISHED_MS },
    sessionId: 'session-recorded'
  })
  assert.equal(temper.artifacts.length, 0, 'the run ending writes nothing to temper')

  // The person presses Record this work.
  const recorded = await worker.request('temper.work.record' as never, { itemId: TASK_ID, workspaceId: WORKSPACE.id } as never)
  assert.equal((recorded as { state: string }).state, 'recorded')
  assert.equal(temper.artifacts.length, 1, "the task's artifacts hold one orca-work record")
  const artifact = temper.artifacts[0] as { resource_id: string; artifact_kind: string; content: Record<string, unknown> }
  assert.equal(artifact.resource_id, TASK_ID)
  assert.equal(artifact.artifact_kind, 'orca-work')
  const content = artifact.content
  assert.equal(content.agent, 'claude')
  assert.equal(content.workspace_name, WORKSPACE.name)
  assert.equal(content.branch, WORKSPACE.branch)
  assert.equal(content.orca_session_id, 'session-recorded')
  assert.equal(typeof content.orca_host, 'string')
  assert.equal(content.started_at, STARTED_AT)
  assert.equal(content.finished_at, new Date(FINISHED_MS).toISOString())
  assert.equal(content.orca_outcome, 'success')
  await worker.deactivate()

  // The plugin's storage is cleared: a fresh worker on this machine, no link left.
  const cleared = orcaHost({})
  const later = await mountWorker(main, { host: cleared })
  const links = (await later.request('temper.launch.links', { itemId: TASK_ID })) as { state: string; links?: unknown[] }
  assert.deepEqual(links.links, [], 'no stored link remains')

  const records = (await later.request('temper.work.records' as never, { itemId: TASK_ID } as never)) as {
    state: string
    records: { artifactId: string; here: boolean; sessionId: string }[]
  }
  assert.equal(records.state, 'ok')
  assert.equal(records.records.length, 1, "the task's record is read back from temper")
  assert.equal(records.records[0].here, true, 'the run was on this Orca host, so Reopen is offered')

  const reopened = (await later.request('temper.work.reopen' as never, {
    itemId: TASK_ID,
    artifactId: records.records[0].artifactId
  } as never)) as { state: string }
  assert.equal(reopened.state, 'reopened')
  assert.deepEqual(cleared.callsOf('agent.resume'), [
    { workspaceId: WORKSPACE.id, agent: 'claude', sessionId: 'session-recorded' }
  ], 'the record resumes the same session, in its workspace')
  await later.deactivate()
})
