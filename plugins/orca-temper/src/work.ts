// The work records, worker side (decision ruling 26): Record this work, the records read back,
// Reopen agent from a record, and temper's claim for the launch sheet.
//
// Write-back is the person's explicit act. Orca reporting a linked run done (./links.ts) writes
// nothing to temper; only the press does, and the press commits one `orca-work` data artifact
// on the task through the temper CLI as the person acting through the plugin's UI — the fixed
// persona the body Save uses (./editor-room/save.ts), a confidence band, never a model. The
// content is the run's coordinates and nothing else (schemas/orca-work.schema.json): no
// transcript, no terminal output, no filesystem path, no field that reads as task state. A
// second press for the same run — its own session and finish time — writes nothing: presses
// still out are joined, and the task's records are read before every commit.
//
// The records are read back on the grant through temper-ts, and each says whether its run was
// on this Orca host, by `orca_host`: an opaque digest of this machine (and Orca's host id for a
// workspace that is not local). Reopen from a record needs no stored link: the worker reads the
// record by id, finds its workspace by name in `workspace.list`, and resumes its session.
//
// The boundary `orca-records-are-never-task-state`: nothing in this module produces a task's
// stage, claim or work in flight from a link or a record. The claim the sheet shows is read
// from temper's open meta, as temper holds it, whoever holds it.
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostParams } from 'orca/host'
import type { OrcaWorkerApi } from 'orca/worker'
import { createTemperClient } from '../vendor/temper-ts.mjs'
import { deps } from './deps'
import { SAVE_CONFIDENCE, SAVE_PERSONA } from './editor-room/save'
import { linkedRuns, outcomeWord, type LinkedRun } from './links'
import type { Gate } from './editor-room/open-body'
import { GrantLostError, type TemperRead } from './reads'
import {
  ORCA_OUTCOMES,
  ORCA_WORK_KIND,
  type OrcaOutcome,
  type OrcaWorkContent,
  type RecordableRun,
  type RecordWorkInput,
  type RecordWorkOutput,
  type ReopenRecordInput,
  type ReopenRecordOutput,
  type TaskClaim,
  type TaskClaimInput,
  type TaskClaimOutput,
  type WorkRecord,
  type WorkRecordsInput,
  type WorkRecordsOutput
} from './work-protocol'


type ResumableAgent = HostParams<'agent.resume'>['agent']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** How many of a task's records the rail reads, newest first. */
export const WORK_RECORDS_BOUND = 50

/** This machine as `orca_host` names it: a digest, so no machine name leaves it. */
export function machineHost(): string {
  return `orca-host:${createHash('sha256').update(deps.machine()).digest('hex').slice(0, 16)}`
}

/** The `orca_host` of a run in a workspace on Orca's host `hostId` (`local`, `ssh:…`, or none). */
export function orcaHostOf(hostId: string | null | undefined): string {
  const base = machineHost()
  return hostId === null || hostId === undefined || hostId === '' || hostId === 'local' ? base : `${base}/${hostId}`
}

/** Whether a record's run was on this Orca host — the only host its session resumes on. */
export function isHere(orcaHost: string): boolean {
  const base = machineHost()
  return orcaHost === base || orcaHost.startsWith(`${base}/`)
}

/** Orca's host id a record's `orca_host` names; `local` when it names this machine alone. */
function hostIdOf(orcaHost: string): string {
  const slash = orcaHost.indexOf('/')
  return slash === -1 ? 'local' : orcaHost.slice(slash + 1)
}

/**
 * The record a finished linked run makes: exactly the shape's fields, from the stored link and
 * Orca's listing of its workspace. Null when the run has not finished or names no session.
 */
export function recordContent(run: LinkedRun): OrcaWorkContent | null {
  if (
    run.sessionId === null ||
    run.agent === null ||
    run.finishedAt === null ||
    !Number.isFinite(Date.parse(run.startedAt))
  ) {
    return null
  }
  return {
    agent: run.agent,
    workspace_name: run.name,
    ...(typeof run.branch === 'string' && run.branch !== '' ? { branch: run.branch } : {}),
    orca_session_id: run.sessionId,
    orca_host: orcaHostOf(run.hostId),
    started_at: new Date(run.startedAt).toISOString(),
    finished_at: run.finishedAt,
    orca_outcome: outcomeWord(run.outcome) as OrcaOutcome
  }
}

/** A stored artifact's content as a record's, or null when it is not one this rail can read. */
export function parseWorkContent(content: unknown): OrcaWorkContent | null {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    return null
  }
  const row = content as Record<string, unknown>
  const text = (key: string): string | null =>
    typeof row[key] === 'string' && row[key] !== '' ? (row[key] as string) : null
  const agent = text('agent')
  const workspaceName = text('workspace_name')
  const sessionId = text('orca_session_id')
  const host = text('orca_host')
  const startedAt = text('started_at')
  const finishedAt = text('finished_at')
  const outcome = text('orca_outcome')
  if (
    agent === null ||
    workspaceName === null ||
    sessionId === null ||
    host === null ||
    startedAt === null ||
    finishedAt === null ||
    outcome === null ||
    !(ORCA_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    return null
  }
  const branch = text('branch')
  const note = text('session_note')
  return {
    agent,
    workspace_name: workspaceName,
    ...(branch === null ? {} : { branch }),
    orca_session_id: sessionId,
    orca_host: host,
    started_at: startedAt,
    finished_at: finishedAt,
    orca_outcome: outcome as OrcaOutcome,
    ...(note === null ? {} : { session_note: note })
  }
}

/** The same run: its own session and finish time. */
function sameRun(a: Pick<OrcaWorkContent, 'orca_session_id' | 'finished_at'>, b: Pick<OrcaWorkContent, 'orca_session_id' | 'finished_at'>): boolean {
  return a.orca_session_id === b.orca_session_id && Date.parse(a.finished_at) === Date.parse(b.finished_at)
}

interface StoredRecord {
  artifactId: string
  content: OrcaWorkContent
}

function clientOf(read: TemperRead) {
  return createTemperClient({ baseUrl: read.apiUrl, credentials: read.credentials, fetch: read.fetch })
}

/** A task's live `orca-work` artifacts, newest first, malformed ones left out. */
export async function readWorkRecords(read: TemperRead, taskId: string): Promise<StoredRecord[]> {
  const { data, error, response } = await clientOf(read).GET('/api/resources/{id}/artifacts', {
    params: {
      path: { id: taskId },
      query: { kind: ORCA_WORK_KIND, limit: WORK_RECORDS_BOUND, order: 'desc' }
    }
  })
  if (error || !data) {
    if (response.status === 401) {
      throw new GrantLostError()
    }
    throw new Error(`temper refused the work records read: ${JSON.stringify(error)}`)
  }
  const records: StoredRecord[] = []
  for (const artifact of data as { artifact_id: string; artifact_kind: string; content?: unknown; is_folded?: boolean }[]) {
    if (artifact.artifact_kind !== ORCA_WORK_KIND || artifact.is_folded === true) {
      continue
    }
    const content = parseWorkContent(artifact.content)
    if (content !== null) {
      records.push({ artifactId: artifact.artifact_id, content })
    }
  }
  records.sort((a, b) => Date.parse(b.content.finished_at) - Date.parse(a.content.finished_at))
  return records
}

/** A record as the rail shows it. Only the run's coordinates — never a stage or a claim. */
function shown(record: StoredRecord): WorkRecord {
  const content = record.content
  return {
    artifactId: record.artifactId,
    agent: content.agent,
    workspaceName: content.workspace_name,
    branch: content.branch ?? null,
    sessionId: content.orca_session_id,
    startedAt: content.started_at,
    finishedAt: content.finished_at,
    outcome: content.orca_outcome,
    sessionNote: content.session_note ?? null,
    here: isHere(content.orca_host)
  }
}

/** The CLI's arguments for one record's commit; never a `--model`: the person pressed it. */
export function recordArgs(taskId: string, contentFile: string): string[] {
  return [
    'data-artifact',
    'commit',
    taskId,
    '--kind',
    ORCA_WORK_KIND,
    '--intent',
    'member',
    '--content',
    `@${contentFile}`,
    '--persona',
    SAVE_PERSONA,
    '--confidence',
    SAVE_CONFIDENCE,
    '--format',
    'json'
  ]
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Commits one record through the temper CLI and answers its artifact id. */
async function commitRecord(taskId: string, content: OrcaWorkContent): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-temper-work-'))
  try {
    const file = join(dir, 'orca-work.json')
    await writeFile(file, JSON.stringify(content), 'utf8')
    const result = await deps.run(recordArgs(taskId, file), process.env)
    const answer = parseJson(result.stdout)
    if (result.code === 0) {
      const id = answer?.['artifact_id'] ?? answer?.['id']
      if (typeof id !== 'string' || id === '') {
        throw new Error('temper took the record but answered no artifact id')
      }
      return id
    }
    const code = typeof answer?.['code'] === 'string' ? answer['code'] : null
    if (code === 'NOT_AUTHENTICATED' || code === 'UNAUTHORIZED' || code === 'UNAUTHENTICATED') {
      throw new GrantLostError()
    }
    const words =
      (typeof answer?.['message'] === 'string' ? answer['message'] : '') ||
      result.stderr.trim().split('\n')[0] ||
      `exit ${result.code}`
    throw new Error(`temper refused the record, and nothing was written: ${words}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** temper's claim on a task, from its open meta as temper holds it; null when none is held. */
export async function readTaskClaim(read: TemperRead, id: string): Promise<TaskClaim | null> {
  const { data, error, response } = await clientOf(read).GET('/api/resources/{id}', {
    params: { path: { id } }
  })
  if (error || !data) {
    if (response.status === 401) {
      throw new GrantLostError()
    }
    throw new Error(`temper refused the claim read: ${JSON.stringify(error)}`)
  }
  const open = (data as { open_meta?: unknown }).open_meta
  const meta = open !== null && typeof open === 'object' && !Array.isArray(open) ? (open as Record<string, unknown>) : {}
  const text = (key: string): string | null =>
    typeof meta[key] === 'string' && meta[key] !== '' ? (meta[key] as string) : null
  const claimId = text('claim_id')
  return claimId === null ? null : { claimId, claimedAt: text('claimed_at'), heartbeatAt: text('heartbeat_at') }
}

/** A host call's refusal code, when it carried one. */
function refusalCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : null
}

export function registerWork(orca: OrcaWorkerApi, gate: Gate): void {
  /** Presses still out, by task × session × finish time: a second press joins the first. */
  const inFlight = new Map<string, Promise<RecordWorkOutput>>()

  orca.panels.handle('temper.work.records', async (input: WorkRecordsInput): Promise<WorkRecordsOutput> => {
    if (!UUID.test(String(input?.itemId ?? ''))) {
      return { state: 'failed', message: 'a bare UUID names the task, and none was sent' }
    }
    return gate(async (read) => {
      const records = await readWorkRecords(read, input.itemId)
      let runs: LinkedRun[] = []
      try {
        runs = await linkedRuns(orca, input.itemId)
      } catch {
        // No stored links readable here: the records still answer, nothing is offered to record.
      }
      const recordable: RecordableRun[] = []
      for (const run of runs) {
        const content = recordContent(run)
        if (content !== null && !records.some((record) => sameRun(record.content, content))) {
          recordable.push({
            workspaceId: run.workspaceId,
            workspaceName: run.name,
            agent: content.agent,
            finishedAt: content.finished_at,
            outcome: content.orca_outcome
          })
        }
      }
      return { state: 'ok' as const, records: records.map(shown), recordable }
    })
  })

  orca.panels.handle('temper.work.record', async (input: RecordWorkInput): Promise<RecordWorkOutput> => {
    if (!UUID.test(String(input?.itemId ?? ''))) {
      return { state: 'failed', message: 'a bare UUID names the task, and none was sent' }
    }
    let run: LinkedRun | undefined
    try {
      run = (await linkedRuns(orca, input.itemId)).find((entry) => entry.workspaceId === input.workspaceId)
    } catch (error) {
      return {
        state: 'failed',
        message: `the stored link could not be read: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    const content = run === undefined ? null : recordContent(run)
    if (content === null) {
      return {
        state: 'failed',
        message: 'no finished run of an agent with a known session is linked to this task in that workspace, so nothing was written'
      }
    }
    const key = `${input.itemId}|${content.orca_session_id}|${content.finished_at}`
    const out = inFlight.get(key)
    if (out !== undefined) {
      const first = await out
      return first.state === 'recorded' ? { state: 'already-recorded', artifactId: first.artifactId } : first
    }
    const press = gate(async (read): Promise<RecordWorkOutput> => {
      const existing = (await readWorkRecords(read, input.itemId)).find((record) => sameRun(record.content, content))
      if (existing !== undefined) {
        return { state: 'already-recorded', artifactId: existing.artifactId }
      }
      return { state: 'recorded', artifactId: await commitRecord(input.itemId, content) }
    })
    inFlight.set(key, press)
    try {
      return await press
    } finally {
      inFlight.delete(key)
    }
  })

  orca.panels.handle('temper.work.reopen', async (input: ReopenRecordInput): Promise<ReopenRecordOutput> => {
    if (!UUID.test(String(input?.itemId ?? '')) || !UUID.test(String(input?.artifactId ?? ''))) {
      return { state: 'failed', message: 'bare UUIDs name the task and its record, and they were not sent' }
    }
    const found = await gate(async (read) => {
      const { data, error, response } = await clientOf(read).GET('/api/data-artifacts/{artifact_id}', {
        params: { path: { artifact_id: input.artifactId } }
      })
      if (error || !data) {
        if (response.status === 401) {
          throw new GrantLostError()
        }
        throw new Error(`temper refused the record read: ${JSON.stringify(error)}`)
      }
      const artifact = data as { resource_id?: string; artifact_kind?: string; content?: unknown }
      if (artifact.resource_id !== input.itemId || artifact.artifact_kind !== ORCA_WORK_KIND) {
        throw new Error('that artifact is not an orca-work record on this task')
      }
      const content = parseWorkContent(artifact.content)
      if (content === null) {
        throw new Error('the record does not hold a run this rail can read')
      }
      return { state: 'ok' as const, content }
    })
    if (found.state !== 'ok') {
      return found
    }
    const content = found.content
    if (!isHere(content.orca_host)) {
      return { state: 'failed', message: 'the run was on another Orca host; its session resumes only there' }
    }
    let workspaceId: string
    try {
      const listed = await orca.host.call('workspace.list')
      const hostId = hostIdOf(content.orca_host)
      const row = listed.workspaces.find(
        (workspace) =>
          workspace.name === content.workspace_name &&
          (content.branch === undefined || workspace.branch === content.branch) &&
          (hostId === 'local' ? workspace.hostId === null || workspace.hostId === 'local' : workspace.hostId === hostId)
      )
      if (row === undefined) {
        return { state: 'failed', message: `the workspace ${content.workspace_name} is not in Orca now` }
      }
      workspaceId = row.id
    } catch (error) {
      return { state: 'refused', code: refusalCode(error), message: error instanceof Error ? error.message : String(error) }
    }
    try {
      const resumed = await orca.host.call('agent.resume', {
        workspaceId,
        agent: content.agent as ResumableAgent,
        sessionId: content.orca_session_id
      })
      return { state: 'reopened', terminalId: resumed.terminalId, started: resumed.started }
    } catch (error) {
      return { state: 'refused', code: refusalCode(error), message: error instanceof Error ? error.message : String(error) }
    }
  })

  orca.panels.handle('temper.task.claim', async (input: TaskClaimInput): Promise<TaskClaimOutput> => {
    if (!UUID.test(String(input?.id ?? ''))) {
      return { state: 'failed', message: 'a bare UUID names the task, and none was sent' }
    }
    return gate(async (read) => ({ state: 'ok' as const, claim: await readTaskClaim(read, input.id) }))
  })
}
