// The panel <-> worker contract for the work records (decision ruling 26), declared beside the
// rest of ./protocol.ts:
//
//   temper.work.records — a task's `orca-work` records read from temper, newest first, each
//                         saying whether its run was on this Orca host; and the linked runs
//                         that have finished here and are not recorded yet (Record this work)
//   temper.work.record  — Record this work: one `orca-work` artifact committed on the task
//                         through the temper CLI, as the person acting through the plugin's UI;
//                         a run already recorded is answered, never written twice
//   temper.work.reopen  — Reopen agent from a record: `agent.resume` with the record's session,
//                         in the workspace its name finds, on this host only
//   temper.task.claim   — temper's claim on a task (`claim_id`, `claimed_at`, `heartbeat_at`),
//                         read for the launch sheet; it never stops a launch
//
// Nothing here is task state. A record says where and when an Orca run happened and Orca's word
// for how it ended; the stage, the claim and the work in flight are read from temper alone.
import type { RegionFailure, ReopenOutput } from './protocol'

/** The family name the records are committed under. */
export const ORCA_WORK_KIND = 'orca-work'

/** Orca's words for how a run ended, and `unreported` when Orca named none. */
export const ORCA_OUTCOMES = [
  'success',
  'failure',
  'cancellation',
  'superseded',
  'interruption',
  'unconfirmed',
  'unreported'
] as const
export type OrcaOutcome = (typeof ORCA_OUTCOMES)[number]

/** One record's content, exactly the fields of schemas/orca-work.schema.json. */
export interface OrcaWorkContent {
  agent: string
  workspace_name: string
  branch?: string
  orca_session_id: string
  orca_host: string
  started_at: string
  finished_at: string
  orca_outcome: OrcaOutcome
  session_note?: string
}

/** One `orca-work` record as the rail shows it. */
export interface WorkRecord {
  artifactId: string
  agent: string
  workspaceName: string
  branch: string | null
  sessionId: string
  startedAt: string
  finishedAt: string
  outcome: OrcaOutcome
  sessionNote: string | null
  /** Whether the run was on this Orca host — Reopen is offered only then. */
  here: boolean
}

/** A linked run that finished here and has no record yet: Record this work offers it. */
export interface RecordableRun {
  workspaceId: string
  workspaceName: string
  agent: string
  finishedAt: string
  outcome: OrcaOutcome
}

export interface WorkRecordsInput {
  itemId: string
}

export type WorkRecordsOutput =
  | { state: 'ok'; records: WorkRecord[]; recordable: RecordableRun[] }
  | RegionFailure

export interface RecordWorkInput {
  itemId: string
  workspaceId: string
}

export type RecordWorkOutput =
  | { state: 'recorded'; artifactId: string }
  /** The run's own session and finish time are already recorded on the task: nothing written. */
  | { state: 'already-recorded'; artifactId: string }
  | RegionFailure

export interface ReopenRecordInput {
  itemId: string
  artifactId: string
}

export type ReopenRecordOutput = ReopenOutput | { state: 'not-connected'; message: string }

/** temper's claim on a task, as its open meta holds it. */
export interface TaskClaim {
  claimId: string
  claimedAt: string | null
  heartbeatAt: string | null
}

export interface TaskClaimInput {
  id: string
}

export type TaskClaimOutput = { state: 'ok'; claim: TaskClaim | null } | RegionFailure

/** Record this work needs the stored link (`storage:own`) and the workspace's name. */
export const RECORD_WORK_NEEDS = ['workspace:read', 'storage:own'] as const
/** Reopen from a record needs the workspace list and `agent.resume`; no stored link. */
export const REOPEN_RECORD_NEEDS = ['workspace:read', 'agent:launch'] as const

declare module 'orca' {
  interface PluginRequests {
    /** A task's `orca-work` records and its finished, unrecorded linked runs. */
    'temper.work.records': { input: WorkRecordsInput; output: WorkRecordsOutput }
    /** Record this work: one `orca-work` artifact on the task, once per run. */
    'temper.work.record': { input: RecordWorkInput; output: RecordWorkOutput }
    /** Reopen agent from a record: agent.resume with its session, on this host. */
    'temper.work.reopen': { input: ReopenRecordInput; output: ReopenRecordOutput }
    /** temper's claim on a task, for the launch sheet. */
    'temper.task.claim': { input: TaskClaimInput; output: TaskClaimOutput }
  }
}
