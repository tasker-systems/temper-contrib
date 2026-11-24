// A task's work in Orca, on its detail (decision ruling 26): the runs recorded on the task in
// temper, and Record this work for a linked run that finished here and is not recorded yet.
//
// - Record this work is the only write, and it is the person's press: one press commits one
//   `orca-work` record through the worker, and the button is gone once the record reads back.
//   Nothing is recorded because a run finished; the run ending only lights the press.
// - Each record is a row naming its workspace, agent and Orca's outcome word, and, for a run on
//   this Orca host, Reopen agent labelled with the run's date — offered whatever the task's
//   stage, so it never implies the task is live here. A run elsewhere says where it resumes.
// - The task's stage, claim and work in flight are never read from here: the detail's header
//   reads them from temper (./panel.tsx), and nothing in this region is shown as task state.
import {
  atom,
  Badge,
  Callout,
  Heading,
  List,
  ListItem,
  plugin,
  read,
  set,
  Skeleton,
  Stack,
  Text,
  type OrcaNode
} from 'orca'
import { ConsentNote, GatedAction, grantedCapabilities } from './capabilities'
import { FocusOutcome, GoToAgent } from './focus-agent'
import { formatTime } from './look'
import type { RecordDetail } from './protocol'
import {
  RECORD_WORK_NEEDS,
  REOPEN_RECORD_NEEDS,
  type RecordableRun,
  type RecordWorkOutput,
  type ReopenRecordOutput,
  type WorkRecord,
  type WorkRecordsOutput
} from './work-protocol'

/** Each task's records as last read; null while the read is out. */
const workRecords = atom<Record<string, WorkRecordsOutput | null>>('work-records', {})

/** The last Record this work press per task × workspace, null while it is out. */
const recordAnswers = atom<Record<string, RecordWorkOutput | null>>('work-record-answers', {})

/** The last Reopen from a record, for the task and record it was pressed on. */
interface RecordReopen {
  itemId: string
  artifactId: string
  workspaceName: string
  output: ReopenRecordOutput | null
}
const recordReopen = atom<RecordReopen | null>('work-record-reopen', null)

/** Reads a task's records again. A read that never answers is the region's failure. */
export async function loadWorkRecords(itemId: string): Promise<void> {
  set(workRecords, { ...read(workRecords), [itemId]: read(workRecords)[itemId] ?? null })
  let answer: WorkRecordsOutput
  try {
    answer = await plugin.request('temper.work.records', { itemId })
  } catch (error) {
    answer = {
      state: 'failed',
      message: `the work records read never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(workRecords, { ...read(workRecords), [itemId]: answer })
}

const recordKey = (itemId: string, workspaceId: string) => `${itemId}|${workspaceId}`

/** Record this work: one press, one record. A press still out disables its button. */
async function recordWork(itemId: string, run: RecordableRun): Promise<void> {
  const key = recordKey(itemId, run.workspaceId)
  if (read(recordAnswers)[key] === null) {
    return
  }
  set(recordAnswers, { ...read(recordAnswers), [key]: null })
  let answer: RecordWorkOutput
  try {
    answer = await plugin.request('temper.work.record', { itemId, workspaceId: run.workspaceId })
  } catch (error) {
    answer = {
      state: 'failed',
      message: `the record request never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(recordAnswers, { ...read(recordAnswers), [key]: answer })
  if (answer.state === 'recorded' || answer.state === 'already-recorded') {
    await loadWorkRecords(itemId)
  }
}

async function reopenRecord(itemId: string, record: WorkRecord): Promise<void> {
  const pending: RecordReopen = { itemId, artifactId: record.artifactId, workspaceName: record.workspaceName, output: null }
  set(recordReopen, pending)
  let output: ReopenRecordOutput
  try {
    output = await plugin.request('temper.work.reopen', { itemId, artifactId: record.artifactId })
  } catch (error) {
    output = {
      state: 'failed',
      message: `the reopen request never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(recordReopen, { ...pending, output })
}

/** Orca's outcome word as the row says it: about the run, never the task. */
function outcomeWords(outcome: string): string {
  return outcome === 'unreported' ? 'Orca named no outcome' : `Orca: ${outcome}`
}

/** A run's date as its Reopen is labelled: the day it finished, in UTC. */
export function runLabel(finishedAt: string): string {
  return `run of ${formatTime(finishedAt).replace(/, \d{2}:\d{2} UTC$/, '')}`
}

/** When a run ran: one day's span reads "22 Nov 2026, 20:30–22:30 UTC". */
export function runSpan(startedAt: string, finishedAt: string): string {
  const start = formatTime(startedAt)
  const end = formatTime(finishedAt)
  const day = /^(.*), (\d{2}:\d{2}) UTC$/
  const a = start.match(day)
  const b = end.match(day)
  return a !== null && b !== null && a[1] === b[1] ? `${a[1]}, ${a[2]}–${b[2]} UTC` : `${start} → ${end}`
}

function RecordPress(props: { itemId: string; run: RecordableRun }): OrcaNode {
  const key = recordKey(props.itemId, props.run.workspaceId)
  const answers = read(recordAnswers)
  const answer = answers[key]
  const sending = answer === null
  return (
    <Stack gap="xs">
      {sending ? (
        <Text muted size="xs">
          {`◌ recording the run in ${props.run.workspaceName} …`}
        </Text>
      ) : (
        <GatedAction
          needs={RECORD_WORK_NEEDS}
          granted={read(grantedCapabilities)}
          label={`Record this work — ${props.run.workspaceName}`}
          variant="outline"
          icon="database"
          named={false}
          onPress={() => void recordWork(props.itemId, props.run)}
        />
      )}
      <Text muted size="xs">
        {`${props.run.agent} finished ${formatTime(props.run.finishedAt)} · ${outcomeWords(props.run.outcome)}. Recording writes where and when it ran to the task in temper — no transcript, and never the task's stage.`}
      </Text>
      {answer === undefined || answer === null || answer.state === 'recorded' || answer.state === 'already-recorded' ? undefined : (
        <Callout tone="warning" title="The run was not recorded">
          <Text muted size="xs">
            {answer.message}
          </Text>
        </Callout>
      )}
    </Stack>
  )
}

function ReopenRecordOutcome(props: { itemId: string; artifactId: string }): OrcaNode {
  const answer = read(recordReopen)
  if (answer === null || answer.itemId !== props.itemId || answer.artifactId !== props.artifactId) {
    return undefined
  }
  const output = answer.output
  if (output === null) {
    return (
      <Text muted size="xs">
        {`◌ reopening the agent in ${answer.workspaceName} …`}
      </Text>
    )
  }
  if (output.state === 'reopened') {
    // The record names no terminal; the reopen answered the one it resumed in.
    const place = { workspaceId: '', terminalId: output.terminalId }
    return (
      <Stack gap="xs">
        <Callout
          tone="success"
          title={
            output.started
              ? `The agent session was reopened in ${answer.workspaceName}.`
              : `The agent session is already running in ${answer.workspaceName}.`
          }
        />
        <GoToAgent place={place} />
        <FocusOutcome place={place} />
      </Stack>
    )
  }
  return output.state === 'refused' ? (
    <Callout tone="danger" title="Orca refused">
      <Text size="sm">{`${output.message}${output.code === null ? '' : ` (${output.code})`}`}</Text>
    </Callout>
  ) : (
    <Callout tone="warning" title="The reopen never ran">
      <Text size="sm">{output.message}</Text>
    </Callout>
  )
}

function RecordRow(props: { itemId: string; record: WorkRecord }): OrcaNode {
  const record = props.record
  return (
    <ListItem
      title={record.workspaceName}
      icon="agent"
      description={`${record.agent} · ${outcomeWords(record.outcome)}`}
    >
      <Text muted size="xs">
        {runSpan(record.startedAt, record.finishedAt)}
      </Text>
      {record.here ? (
        <GatedAction
          needs={REOPEN_RECORD_NEEDS}
          granted={read(grantedCapabilities)}
          label={`Reopen agent — ${runLabel(record.finishedAt)}`}
          variant="outline"
          icon="agent"
          named={false}
          onPress={() => void reopenRecord(props.itemId, record)}
        />
      ) : (
        <Text muted size="xs">
          Run on another Orca host — its session reopens only there.
        </Text>
      )}
      <ReopenRecordOutcome itemId={props.itemId} artifactId={record.artifactId} />
    </ListItem>
  )
}

/** The region on a task's detail; none on other records, none while signed out. */
export function WorkRegion(props: { detail: RecordDetail }): OrcaNode {
  if (props.detail.docType !== 'task') {
    return undefined
  }
  const itemId = props.detail.id
  const answer = read(workRecords)[itemId]
  const heading = (count: number | null) => (
    <Stack gap="xs">
      <Heading level={3}>
        work in Orca {count === null ? undefined : <Badge>{String(count)}</Badge>}
      </Heading>
      <Text muted size="xs">
        runs recorded on this task in temper, newest first — where and when, never its stage or claim
      </Text>
    </Stack>
  )
  if (answer === undefined || answer === null) {
    return (
      <Stack gap="sm">
        {heading(null)}
        <Text muted size="xs">
          ◌ Loading the recorded runs…
        </Text>
        <Skeleton lines={2} label="◌ Loading the recorded runs…" />
      </Stack>
    )
  }
  if (answer.state === 'not-connected') {
    return undefined
  }
  if (answer.state === 'failed') {
    return (
      <Stack gap="sm">
        {heading(null)}
        <Callout tone="warning" title="the recorded runs are unavailable — nothing here was read.">
          <Text muted size="xs">
            {answer.message}
          </Text>
        </Callout>
      </Stack>
    )
  }
  const granted = read(grantedCapabilities)
  return (
    <Stack gap="sm">
      {heading(answer.records.length)}
      {answer.recordable.map((run) => (
        <RecordPress key={`record-${run.workspaceId}`} itemId={itemId} run={run} />
      ))}
      {answer.recordable.length === 0 ? undefined : (
        <ConsentNote act="Record this work" needs={RECORD_WORK_NEEDS} granted={granted} />
      )}
      {answer.records.length === 0 ? (
        <Text muted size="xs">
          — No Orca runs recorded on this task.
        </Text>
      ) : (
        <Stack gap="xs">
          <List label="recorded runs">
            {answer.records.map((record) => (
              <RecordRow key={record.artifactId} itemId={itemId} record={record} />
            ))}
          </List>
          {answer.records.some((record) => record.here) ? (
            <ConsentNote act="Reopen agent" needs={REOPEN_RECORD_NEEDS} granted={granted} />
          ) : undefined}
        </Stack>
      )}
    </Stack>
  )
}
