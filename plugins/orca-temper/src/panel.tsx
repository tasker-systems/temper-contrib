// No build step: Orca strips the types and compiles the JSX when the panel loads. The panel
// never talks to temper itself — the worker does, on the borrowed grant — and shows either the
// in-force state in three groups or the signed-out refusal. The handoff's Next steps render as
// Markdown; the lists carry the ids and titles the worker answered, with counts, nothing more.
import {
  atom,
  Button,
  EmptyState,
  Heading,
  List,
  ListItem,
  Markdown,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type {
  ActiveGoalsOutput,
  InProgressTasksOutput,
  LatestHandoffOutput,
  ResourceSummary
} from './protocol'

/** The worker's last answers; null while each request is out. */
const goalsResult = atom<ActiveGoalsOutput | null>(null)
const tasksResult = atom<InProgressTasksOutput | null>(null)
const handoffResult = atom<LatestHandoffOutput | null>(null)
/** True while any request is out. */
const loading = atom('loading', false)

async function refresh(): Promise<void> {
  set(loading, true)
  try {
    const [goals, tasks, handoff] = await Promise.all([
      plugin.request('temper.goals.active'),
      plugin.request('temper.tasks.in-progress'),
      plugin.request('temper.handoff.latest')
    ])
    set(goalsResult, goals)
    set(tasksResult, tasks)
    set(handoffResult, handoff)
  } finally {
    set(loading, false)
  }
}

/** Runs once before the first render. */
export function setup(_ctx: PanelContext): void {
  void refresh()
}

function contextLine(contexts: string[]) {
  return (
    <Text muted size="xs">
      {contexts.join(', ')}
    </Text>
  )
}

/** One list group: a counted heading, the contexts it read, its rows or its empty text. */
function ResourceList(props: {
  label: string
  count: number
  contexts: string[]
  items: ResourceSummary[]
  empty: string
  icon: 'flag' | 'hammer'
  truncatedNotice: string | null
}) {
  return (
    <Stack gap="sm">
      <Heading>{`${props.label} (${props.count})`}</Heading>
      {contextLine(props.contexts)}
      {props.items.length === 0 ? (
        <Text muted size="xs">
          {props.empty}
        </Text>
      ) : (
        <List label={props.label}>
          {props.items.map((item) => (
            <ListItem key={item.id} title={item.title} description={item.ref} icon={props.icon} />
          ))}
        </List>
      )}
      {props.truncatedNotice === null ? undefined : (
        <Text tone="warning" size="xs">
          {props.truncatedNotice}
        </Text>
      )}
    </Stack>
  )
}

export default function Panel() {
  const goals = read(goalsResult)
  const tasks = read(tasksResult)
  const handoff = read(handoffResult)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Temper</Heading>
        <Button variant="ghost" icon="refresh" onPress={refresh} disabled={read(loading)}>
          Refresh
        </Button>
      </Row>
      {goals === null || tasks === null || handoff === null ? (
        <Row gap="sm" align="center">
          <Spinner label="Reading temper" labelHidden />
          <Text muted>Reading temper…</Text>
        </Row>
      ) : !goals.connected && !tasks.connected && !handoff.connected ? (
        <Stack gap="sm">
          <EmptyState title="temper is not connected" description={goals.message} icon="warning" />
        </Stack>
      ) : (
        <Stack gap="md">
          {goals.connected ? (
            <ResourceList
              label="Active goals"
              count={goals.goals.length}
              contexts={goals.contexts}
              items={goals.goals}
              empty={`No active goals in ${goals.contexts.join(', ')}.`}
              icon="flag"
              truncatedNotice={goals.truncated ? 'More goals than fit this page — narrow the context.' : null}
            />
          ) : (
            <Stack gap="sm">
              <Heading>Active goals</Heading>
              <Text tone="warning">{goals.message}</Text>
            </Stack>
          )}
          {tasks.connected ? (
            <ResourceList
              label="Tasks in progress"
              count={tasks.tasks.length}
              contexts={tasks.contexts}
              items={tasks.tasks}
              empty={`No tasks in progress in ${tasks.contexts.join(', ')}.`}
              icon="hammer"
              truncatedNotice={tasks.truncated ? 'More tasks than fit this page — narrow the context.' : null}
            />
          ) : (
            <Stack gap="sm">
              <Heading>Tasks in progress</Heading>
              <Text tone="warning">{tasks.message}</Text>
            </Stack>
          )}
          {handoff.connected ? (
            <Stack gap="sm">
              <Heading>{`Latest handoff (${handoff.handoff === null ? 0 : 1})`}</Heading>
              {contextLine(handoff.contexts)}
              {handoff.handoff === null ? (
                <Text muted size="xs">
                  {`No session notes in ${handoff.contexts.join(', ')}.`}
                </Text>
              ) : (
                <Stack gap="sm">
                  <Text>{handoff.handoff.title}</Text>
                  {handoff.handoff.nextSteps === null ? (
                    <Text muted size="xs">
                      The latest note carries no Next steps section.
                    </Text>
                  ) : (
                    <Markdown content={handoff.handoff.nextSteps} />
                  )}
                </Stack>
              )}
              {handoff.truncated ? (
                <Text muted size="xs">
                  Older session notes exist — the panel shows the latest only.
                </Text>
              ) : undefined}
            </Stack>
          ) : (
            <Stack gap="sm">
              <Heading>Latest handoff</Heading>
              <Text tone="warning">{handoff.message}</Text>
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  )
}
