// The detail's "Open body" action: one press asks the worker to open the record's body in an
// editor tab of the focused workspace. Lit only by the consents it needs (GatedAction); the
// answer stands under it in its own words — where the tab opened and when its base was read,
// or why nothing was opened. The rail itself never draws the body.
import { atom, read, set, Stack, Text, plugin } from 'orca'
import { GatedAction, grantedCapabilities } from '../capabilities'
import type { OpenBodyOutput } from './protocol'

/** The consents Open body needs: find the workspace, open its file, hold the base. */
export const OPEN_BODY_NEEDS = ['workspace:read', 'workspace:write', 'storage:own'] as const

/** Each record's last answer; `pending` while the press is out. */
const openBodyResults = atom('open-body-results', {} as Record<string, OpenBodyOutput | 'pending'>)

async function openBody(id: string): Promise<void> {
  set(openBodyResults, { ...read(openBodyResults), [id]: 'pending' })
  let answer: OpenBodyOutput
  try {
    answer = await plugin.request('temper.body.open', { id })
  } catch (error) {
    answer = { state: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
  set(openBodyResults, { ...read(openBodyResults), [id]: answer })
}

function AnswerLine(props: { answer: OpenBodyOutput | 'pending' | undefined }) {
  const answer = props.answer
  if (answer === undefined) {
    return undefined
  }
  if (answer === 'pending') {
    return <Text muted size="xs">◌ Opening the body…</Text>
  }
  if (answer.state === 'opened') {
    return (
      <Text muted size="xs">
        {`Opened ${answer.path} in an editor tab of ${answer.workspace} — base read ${answer.readAt}.`}
      </Text>
    )
  }
  return (
    <Text tone="warning" size="xs">
      {`⚠ ${answer.message}`}
    </Text>
  )
}

export function OpenBodyAction(props: { id: string }) {
  return (
    <Stack gap="xs">
      <GatedAction
        needs={OPEN_BODY_NEEDS}
        granted={read(grantedCapabilities)}
        label="Open body"
        variant="outline"
        onPress={() => void openBody(props.id)}
      />
      <AnswerLine answer={read(openBodyResults)[props.id]} />
    </Stack>
  )
}
