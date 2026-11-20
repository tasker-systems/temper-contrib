// No build step: Orca strips the types and compiles the JSX when the panel loads. The panel
// never talks to temper itself — the worker does, on the borrowed grant, and the panel shows
// either the goals or the signed-out refusal.
import {
  atom,
  Button,
  EmptyState,
  Heading,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { ActiveGoalsOutput } from './protocol'

/** The worker's last answer; null until it answers. */
const result = atom<ActiveGoalsOutput | null>(null)
/** True while a request is out. */
const loading = atom('loading', false)

async function refresh(): Promise<void> {
  set(loading, true)
  try {
    set(result, await plugin.request('temper.goals.active'))
  } finally {
    set(loading, false)
  }
}

/** Runs once before the first render. */
export function setup(_ctx: PanelContext): void {
  void refresh()
}

export default function Panel() {
  const answer = read(result)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Active goals</Heading>
        <Button variant="ghost" icon="refresh" onPress={refresh} disabled={read(loading)}>
          Refresh
        </Button>
      </Row>
      {answer === null ? (
        <Row gap="sm" align="center">
          <Spinner label="Reading active goals" labelHidden />
          <Text muted>Reading active goals…</Text>
        </Row>
      ) : answer.connected ? (
        <Stack gap="sm">
          <Text muted size="xs">
            {answer.contextRef}
          </Text>
          {answer.goals.length === 0 ? (
            <EmptyState title="No active goals" description={`None in ${answer.contextRef}.`} icon="flag" />
          ) : (
            <List label="Active goals">
              {answer.goals.map((goal) => (
                <ListItem key={goal.id} title={goal.title} description={goal.ref} icon="flag" />
              ))}
            </List>
          )}
          {answer.truncated ? (
            <Text tone="warning" size="xs">
              More goals than fit this page — narrow the context.
            </Text>
          ) : undefined}
        </Stack>
      ) : (
        <Stack gap="sm">
          <EmptyState title="temper is not connected" description={answer.message} icon="warning" />
        </Stack>
      )}
    </Stack>
  )
}
