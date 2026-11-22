// Home's "this workspace" strip: the focused workspace, the temper task it serves, and the
// agents in it with their status words. Orca's own reads answer the workspace and its agents
// (`workspace.readContext` and `workspace.changed` under `workspace:read`; `agents.list` and
// `agent.status.changed` under `agent:read`); what it serves is the worker's `temper.serves` —
// the stored link, and the item's record read on the grant — so the panel never talks to temper.
// A workspace no link joins to a task says it serves no temper task; a link to something else
// (a goal, a handoff's session) says the same and names what the workspace was started from.
// The task's stage comes only from temper's read of the record — other agents, elsewhere, may
// be working the same task. The stored link says only which task this workspace was started
// for, and Orca's status words describe Orca's agents, never the task; a record that does not
// answer shows no stage at all.
// Each part keeps the house region states: still out, unavailable, empty, a withheld consent.
import {
  atom,
  Badge,
  Callout,
  Heading,
  host,
  KeyValue,
  List,
  ListItem,
  on,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Skeleton,
  Stack,
  Text,
  type OrcaNode,
  type PanelContext
} from 'orca'
import { ConsentNote, grantedCapabilities, missingConsents } from './capabilities'
import { docTypeIcon, recordState, rowDescription, stateWord } from './look'
import type { ServesOutput } from './protocol'
import { SERVES_AGENTS_NEEDS, SERVES_NEEDS } from './protocol'

/** The focused workspace as Orca names it; undefined until first read, null when none is focused. */
export interface FocusedWorkspace {
  workspaceId: string | null
  displayName: string
  branch: string
}

interface AgentRow {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: string
  stateStartedAt: number
}

type AgentsAnswer = { state: 'ok'; agents: AgentRow[] } | { state: 'failed'; message: string }

const focused = atom<FocusedWorkspace | null | undefined>(undefined)
/** `temper.serves` per workspace id, null while its request is out. */
const servesAnswers = atom<Record<string, ServesOutput | null>>({})
/** `agents.list` per workspace id, null while its call is out. */
const agentsAnswers = atom<Record<string, AgentsAnswer | null>>({})

/** The scope sentence under the heading, in the region's own words. */
const SCOPE = 'the focused workspace, the temper task it serves, and its agents'

function granted(needs: readonly string[]): boolean {
  return missingConsents(needs, read(grantedCapabilities)).length === 0
}

function focusFrom(
  context: { workspaceId?: string; branch: string; displayName: string } | null
): FocusedWorkspace | null {
  return context === null
    ? null
    : { workspaceId: context.workspaceId ?? null, displayName: context.displayName, branch: context.branch }
}

async function loadServes(workspaceId: string): Promise<void> {
  set(servesAnswers, { ...read(servesAnswers), [workspaceId]: null })
  let answer: ServesOutput
  try {
    answer = await plugin.request('temper.serves', { workspaceId })
  } catch (error) {
    answer = {
      state: 'failed',
      message: `the read never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(servesAnswers, { ...read(servesAnswers), [workspaceId]: answer })
}

async function loadAgents(workspaceId: string): Promise<void> {
  if (!granted(SERVES_AGENTS_NEEDS)) {
    return
  }
  if (read(agentsAnswers)[workspaceId] === undefined) {
    set(agentsAnswers, { ...read(agentsAnswers), [workspaceId]: null })
  }
  let answer: AgentsAnswer
  try {
    const listed = await host.call('agents.list', { workspaceId })
    answer = { state: 'ok', agents: listed.agents }
  } catch (error) {
    answer = {
      state: 'failed',
      message: `Orca refused the agents read: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(agentsAnswers, { ...read(agentsAnswers), [workspaceId]: answer })
}

/** A new focus: what it serves and its agents, read again. */
function focus(next: FocusedWorkspace | null): void {
  set(focused, next)
  if (next !== null && next.workspaceId !== null) {
    void loadServes(next.workspaceId)
    void loadAgents(next.workspaceId)
  }
}

/** Home's Refresh: the strip's reads again, for the workspace in focus. */
export function refreshServes(): void {
  const current = read(focused)
  if (current !== undefined) {
    focus(current)
  }
}

/**
 * Called from the panel's setup. The consents are asked first, so no Orca read the person has
 * not granted is ever made; then the focus is read and followed, and the focused workspace's
 * agents are read again as Orca reports their status.
 */
export function setupServes(ctx: PanelContext): void {
  void (async () => {
    try {
      const answer = await plugin.request('temper.capabilities')
      set(grantedCapabilities, answer.granted)
    } catch {
      // Unlit: the strip names the consent it lacks.
    }
    if (ctx.signal.aborted || !granted(SERVES_NEEDS)) {
      return
    }
    ctx.subscriptions.push(on('workspace.changed', (payload) => focus(focusFrom(payload.context))))
    if (granted(SERVES_AGENTS_NEEDS)) {
      ctx.subscriptions.push(
        on('agent.status.changed', (payload) => {
          const id = read(focused)?.workspaceId ?? null
          if (id !== null && (payload.workspaceListId === id || payload.workspaceId === id)) {
            void loadAgents(id)
          }
        })
      )
    }
    try {
      focus(focusFrom(await host.call('workspace.readContext')))
    } catch {
      set(focused, null)
    }
  })()
}

function StillOut(props: { words: string }) {
  return (
    <Stack gap="xs">
      <Text muted size="xs">
        {props.words}
      </Text>
      <Skeleton lines={2} label={props.words} />
    </Stack>
  )
}

function Unavailable(props: { what: string; message: string }) {
  return (
    <Callout tone="warning" title={`${props.what} unavailable — nothing here was read.`}>
      <Text muted size="xs">
        {props.message}
      </Text>
    </Callout>
  )
}

/** What the workspace serves, by the worker's answer. */
function Served(props: { workspaceId: string; onOpen: (entry: OpenEntry) => void }): OrcaNode {
  const answer = read(servesAnswers)[props.workspaceId] ?? null
  if (answer === null) {
    return <StillOut words="◌ Loading what this workspace serves…" />
  }
  if (answer.state === 'failed') {
    return <Unavailable what="what this workspace serves is" message={answer.message} />
  }
  if (answer.state === 'unlinked') {
    return (
      <Text muted size="xs">
        — This workspace serves no temper task.
      </Text>
    )
  }
  const record = answer.record
  const detail = record.state === 'ok' ? record.detail : null
  const docType = detail?.docType ?? answer.item.docType
  const title = detail?.title ?? answer.item.title ?? answer.item.ref
  const state = detail === null ? null : recordState(detail)
  const entry: OpenEntry = { id: answer.item.itemId, ref: answer.item.ref, title, docType: docType ?? '' }
  const row = (
    <List label="serves">
      <ListItem
        title={title}
        icon={docTypeIcon(docType ?? '')}
        description={rowDescription(docType ?? 'record', state)}
        onPress={() => props.onOpen(entry)}
      />
    </List>
  )
  const unread =
    record.state === 'ok' ? undefined : (
      <Text muted size="xs">{`Its record is unavailable — ${record.message}`}</Text>
    )
  if (docType !== 'task') {
    return (
      <Stack gap="xs">
        <Text muted size="xs">
          — This workspace serves no temper task.
        </Text>
        <Text muted size="xs">{`It was started from this ${docType ?? 'record'}:`}</Text>
        {row}
        {unread}
      </Stack>
    )
  }
  const items = [
    { label: 'ref', value: answer.item.ref, code: true },
    ...(answer.item.contextRef === null ? [] : [{ label: 'context', value: answer.item.contextRef }])
  ]
  return (
    <Stack gap="xs">
      <Text muted size="xs">
        serves the task
      </Text>
      {row}
      <KeyValue label="the task it serves" items={items} />
      {unread}
    </Stack>
  )
}

/** The agents in the workspace, each with its status word and how long it has held it. */
function Agents(props: { workspaceId: string }): OrcaNode {
  if (!granted(SERVES_AGENTS_NEEDS)) {
    return <ConsentNote act="The agents line" needs={SERVES_AGENTS_NEEDS} granted={read(grantedCapabilities)} />
  }
  const answer = read(agentsAnswers)[props.workspaceId] ?? null
  if (answer === null) {
    return <StillOut words="◌ Loading its agents…" />
  }
  if (answer.state === 'failed') {
    return <Unavailable what="its agents are" message={answer.message} />
  }
  return (
    <Stack gap="xs">
      <Heading level={3}>
        agents <Badge>{String(answer.agents.length)}</Badge>
      </Heading>
      {answer.agents.length === 0 ? (
        <Text muted size="xs">
          — No agents in this workspace.
        </Text>
      ) : (
        <List label="agents">
          {answer.agents.map((agent, index) => (
            <ListItem
              key={agent.terminalId ?? `agent-${index}`}
              title={agent.title ?? agent.agent ?? 'agent'}
              icon="agent"
              description={`${agent.agent ?? 'agent'} · ${stateWord(agent.state)}`}
            >
              <Row gap="xs" align="center">
                <Text muted size="xs">
                  {`${stateWord(agent.state)} since`}
                </Text>
                <RelativeTime at={agent.stateStartedAt} muted />
              </Row>
            </ListItem>
          ))}
        </List>
      )}
    </Stack>
  )
}

/** What the strip hands the panel to open an item's detail. */
export interface OpenEntry {
  id: string
  ref: string
  title: string
  docType: string
}

/** The strip, at the head of Home. */
export function ServesRegion(props: { onOpen: (entry: OpenEntry) => void }): OrcaNode {
  const heading = (
    <Stack gap="xs">
      <Heading level={3}>this workspace</Heading>
      <Text muted size="xs">
        {SCOPE}
      </Text>
    </Stack>
  )
  if (!granted(SERVES_NEEDS)) {
    return (
      <Stack gap="sm">
        {heading}
        <ConsentNote act="This workspace" needs={SERVES_NEEDS} granted={read(grantedCapabilities)} />
      </Stack>
    )
  }
  const current = read(focused)
  if (current === undefined) {
    return (
      <Stack gap="sm">
        {heading}
        <StillOut words="◌ Loading this workspace…" />
      </Stack>
    )
  }
  if (current === null || current.workspaceId === null) {
    return (
      <Stack gap="sm">
        {heading}
        <Text muted size="xs">
          {current === null ? '— No workspace is focused.' : '— This workspace serves no temper task.'}
        </Text>
      </Stack>
    )
  }
  return (
    <Stack gap="sm">
      {heading}
      <KeyValue
        label="this workspace"
        items={[
          { label: 'workspace', value: current.displayName },
          { label: 'branch', value: current.branch, code: true }
        ]}
      />
      <Served workspaceId={current.workspaceId} onOpen={props.onOpen} />
      <Agents workspaceId={current.workspaceId} />
    </Stack>
  )
}
