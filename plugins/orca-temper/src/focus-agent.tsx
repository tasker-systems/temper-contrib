// Takes the person to an agent: a press on an agent's row in Home's strip, and on Reopen
// agent's and the launch sheet's outcomes. The worker (`temper.agent.focus`) focuses the
// agent's terminal when one is known, and otherwise opens its workspace — Orca has no plugin
// call that focuses a chat tab (stablyai/orca#42069), so a chat's row says it opens the
// workspace. The press moves Orca's view only: it is never task state and writes nothing
// (decision ruling 26). `focused: false` is said quietly, never as an error; without
// `workspace:write` the press is dark and the consent is named.
import { atom, Callout, plugin, read, set, Text, type OrcaNode } from 'orca'
import { GatedAction, grantedCapabilities } from './capabilities'
import type { FocusAgentInput, FocusAgentOutput } from './protocol'
import { FOCUS_AGENT_NEEDS } from './protocol'

/** Where an agent is: its workspace, and its terminal when Orca named one. */
export type AgentPlace = FocusAgentInput

/** The words a chat's press carries: it opens the workspace, not the chat. */
export const OPENS_WORKSPACE = 'opens its workspace — Orca cannot focus a chat tab'

interface FocusAnswer {
  key: string
  output: FocusAgentOutput | null
}

/** The last press's answer, for the place it was pressed on. */
const focusAnswer = atom<FocusAnswer | null>('focus-agent-answer', null)

function keyOf(place: AgentPlace): string {
  return `${place.workspaceId}\u0000${place.terminalId ?? ''}`
}

/** True when the press may run: the consent is granted. */
export function focusGranted(): boolean {
  return FOCUS_AGENT_NEEDS.every((need) => read(grantedCapabilities).includes(need))
}

/** The press: the worker focuses the terminal, or opens the workspace. */
export async function focusAgent(place: AgentPlace): Promise<void> {
  const key = keyOf(place)
  set(focusAnswer, { key, output: null })
  let output: FocusAgentOutput
  try {
    output = await plugin.request('temper.agent.focus', {
      workspaceId: place.workspaceId,
      terminalId: place.terminalId
    })
  } catch (error) {
    output = {
      state: 'failed',
      message: `the request never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(focusAnswer, { key, output })
}

/** What the last press on this place answered; nothing when Orca moved to it. */
export function FocusOutcome(props: { place: AgentPlace }): OrcaNode {
  const answer = read(focusAnswer)
  if (answer === null || answer.key !== keyOf(props.place)) {
    return undefined
  }
  const output = answer.output
  if (output === null) {
    return (
      <Text muted size="xs">
        ◌ Asking Orca to show it…
      </Text>
    )
  }
  if (output.state === 'shown') {
    return output.focused ? undefined : (
      <Text muted size="xs">
        Orca did not move to it.
      </Text>
    )
  }
  return output.state === 'refused' ? (
    <Callout tone="danger" title="Orca refused">
      <Text size="sm">{`${output.message}${output.code === null ? '' : ` (${output.code})`}`}</Text>
    </Callout>
  ) : (
    <Callout tone="warning" title="Orca was not asked">
      <Text size="sm">{output.message}</Text>
    </Callout>
  )
}

/**
 * The press as a button, for an outcome: "Go to the agent" when its terminal is known, else
 * "Open its workspace". Outline beside the outcome's dismissal; dark, with its consent named,
 * without `workspace:write`.
 */
export function GoToAgent(props: { place: AgentPlace }): OrcaNode {
  return (
    <GatedAction
      needs={FOCUS_AGENT_NEEDS}
      granted={read(grantedCapabilities)}
      label={props.place.terminalId === null ? 'Open its workspace' : 'Go to the agent'}
      variant="outline"
      icon="agent"
      onPress={() => void focusAgent(props.place)}
    />
  )
}
