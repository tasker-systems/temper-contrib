// The latest-handoff card's tasks (decision ruling 28): the tasks the session advanced — its
// outgoing `advances` edges — each named with its title and `task · <stage>`, the stage as temper
// holds it (`temper.handoff.tasks`), never as the plugin's links or `orca-work` records hold
// anything (ruling 26). The card's press is labelled by what this read shows; the press reads
// the stages again, and its prompt branches on that read alone (`./launcher`). This region has
// its own states: still out, failed, none — and a failed read never hides the card.
import { atom, Callout, List, ListItem, plugin, read, set, Skeleton, Stack, Text, type OrcaNode } from 'orca'
import { docTypeIcon, rowDescription } from './look'
import { handoffBranch, handoffLabel } from './prompts'
import type { HandoffTasksOutput } from './protocol'

/** What the card's read answered, for the session it was asked of; null while nothing was asked. */
interface CardTasks {
  sessionId: string
  answer: HandoffTasksOutput | null
}

const cardTasks = atom<CardTasks | null>('handoff-card-tasks', null)

/** Asks for the tasks the card's session advanced, with their stages. A read that never
 *  answers is a failure, said in the card. */
export async function loadHandoffTasks(sessionId: string): Promise<void> {
  set(cardTasks, { sessionId, answer: null })
  let answer: HandoffTasksOutput
  try {
    answer = await plugin.request('temper.handoff.tasks', { sessionId })
  } catch (error) {
    answer = {
      state: 'failed',
      message: `the advanced-tasks read never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  // A newer ask (another session became the latest) wins.
  if (read(cardTasks)?.sessionId === sessionId) {
    set(cardTasks, { sessionId, answer })
  }
}

function answerFor(sessionId: string): HandoffTasksOutput | null {
  const held = read(cardTasks)
  return held !== null && held.sessionId === sessionId ? held.answer : null
}

/**
 * The card's press words, by what the card's own read shows: Resume task for one in-progress
 * task, Continue from handoff otherwise — and while the read is out or failed. The sheet's
 * words follow the press's own read, which may differ if a stage moved in between.
 */
export function cardLaunchLabel(sessionId: string): string {
  const answer = answerFor(sessionId)
  return answer !== null && answer.state === 'ok'
    ? handoffLabel(handoffBranch({ state: 'ok', tasks: answer.tasks }))
    : 'Continue from handoff'
}

/** The tasks the card's session advanced, in the card under the session row. */
export function HandoffTasks(props: {
  sessionId: string
  onOpen: (task: { id: string; ref: string; title: string; docType: string }) => void
}): OrcaNode {
  const answer = answerFor(props.sessionId)
  if (answer === null) {
    return (
      <Stack gap="xs">
        <Text muted size="xs">
          ◌ Loading the tasks it advanced…
        </Text>
        <Skeleton lines={1} label="the tasks it advanced" />
      </Stack>
    )
  }
  if (answer.state !== 'ok') {
    return (
      <Callout tone="warning" title="the tasks it advanced unavailable — nothing here was read.">
        <Text muted size="xs">
          {answer.message}
        </Text>
      </Callout>
    )
  }
  if (answer.tasks.length === 0) {
    return (
      <Text muted size="xs">
        — No task advanced.
      </Text>
    )
  }
  return (
    <Stack gap="xs">
      <Text muted size="xs">
        advanced
      </Text>
      <List label="the tasks it advanced">
        {answer.tasks.map((task) => (
          <ListItem
            key={task.id}
            title={task.title}
            icon={docTypeIcon('task')}
            description={rowDescription('task', task.stage)}
            onPress={() => props.onOpen({ id: task.id, ref: task.ref, title: task.title, docType: 'task' })}
          />
        ))}
      </List>
    </Stack>
  )
}
