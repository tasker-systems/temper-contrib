// temper's claim on a task, in the launch sheet before Start agent or Resume task (decision
// ruling 26). The claim is read from temper's open meta as temper holds it — `claim_id`,
// `claimed_at`, `heartbeat_at` — whoever holds it: a cloud agent, another machine, another IDE.
// A held claim is named with how fresh its heartbeat is, and the launch stays possible: the
// rail never writes or gates on a claim (Q3), and temper's guarded claim is the agent's own gate.
// Nothing local — no stored link, no `orca-work` record — is ever read as the claim.
import { atom, Callout, plugin, read, RelativeTime, Row, set, Text, type OrcaNode } from 'orca'
import type { TaskClaimOutput } from './work-protocol'

/** The claim per task as last read; null while the read is out. */
const claims = atom<Record<string, TaskClaimOutput | null>>('task-claims', {})

/** Reads temper's claim on a task again, for a sheet opening on it. */
export async function loadTaskClaim(id: string): Promise<void> {
  set(claims, { ...read(claims), [id]: null })
  let answer: TaskClaimOutput
  try {
    answer = await plugin.request('temper.task.claim', { id })
  } catch (error) {
    answer = {
      state: 'failed',
      message: `the claim read never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(claims, { ...read(claims), [id]: answer })
}

function epoch(value: string | null): number | null {
  if (value === null) {
    return null
  }
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** The sheet's claim line for a task; nothing for a record that is not one. */
export function ClaimLine(props: { itemId: string }): OrcaNode {
  const answer = read(claims)[props.itemId]
  if (answer === undefined) {
    return undefined
  }
  if (answer === null) {
    return (
      <Text muted size="xs">
        ◌ Reading temper's claim on this task…
      </Text>
    )
  }
  if (answer.state !== 'ok') {
    return (
      <Text muted size="xs">
        {`temper's claim on this task could not be read — ${answer.message}. The launch does not wait on it.`}
      </Text>
    )
  }
  const claim = answer.claim
  if (claim === null) {
    return (
      <Text muted size="xs">
        temper shows no claim on this task.
      </Text>
    )
  }
  const claimedAt = epoch(claim.claimedAt)
  const heartbeatAt = epoch(claim.heartbeatAt)
  return (
    <Callout tone="warning" title="temper shows this task claimed">
      <Text size="sm">{`Claim ${claim.claimId.slice(0, 8)} is held — another agent may be working this task.`}</Text>
      <Row gap="xs" align="center">
        <Text muted size="xs">
          claimed
        </Text>
        {claimedAt === null ? (
          <Text muted size="xs">
            at no stated time
          </Text>
        ) : (
          <RelativeTime at={claimedAt} muted />
        )}
        <Text muted size="xs">
          · heartbeat
        </Text>
        {heartbeatAt === null ? (
          <Text muted size="xs">
            none yet
          </Text>
        ) : (
          <RelativeTime at={heartbeatAt} muted />
        )}
      </Row>
      <Text muted size="xs">
        You can still launch; the agent's own claim is temper's to grant or refuse.
      </Text>
    </Callout>
  )
}
