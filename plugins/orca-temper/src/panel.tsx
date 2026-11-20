// No build step: Orca strips the types and compiles the JSX when the panel loads. The rail is
// one panel: Home / Explore / Search sub-tabs on top, and a detail stack in an atom underneath
// — pressing an item pushes a detail view inside the same panel (no Orca method opens another
// panel), Back pops it. The panel never talks to temper itself — the worker does, on the
// borrowed grant — and shows either the in-force state on Home or the signed-out refusal,
// which stands over every tab. The handoff's Next steps render as Markdown; the lists carry
// the ids and titles the worker answered, with counts, nothing more.
//
// Text is temper-design's job: region states carry their own words (◌ loading, — empty,
// ⚠ failed, ⊘ gave up — the last waits for a state that gives up), the doc-type word appears
// on rows instead of icons, and everything reads in sentence case.
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
  Tab,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import { refreshGrantedCapabilities } from './capabilities'
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

/** Which sub-tab holds. */
const activeTab = atom('active-tab', 'home')

/** One pushed detail view: the item's identity and the doc-type word it is. */
interface DetailEntry {
  id: string
  ref: string
  title: string
  docType: 'goal' | 'task'
}

/** The in-panel detail stack: pressing an item pushes, Back pops. Held here, in full. */
const detailStack = atom('detail-stack', [] as DetailEntry[])

function pushDetail(entry: DetailEntry): void {
  set(detailStack, [...read(detailStack), entry])
}

function popDetail(): void {
  set(detailStack, read(detailStack).slice(0, -1))
}

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
    // The consents ride along so actions draw lit or named from the start.
    await refreshGrantedCapabilities()
  } finally {
    set(loading, false)
  }
}

/** Runs once before the first render. */
export function setup(_ctx: PanelContext): void {
  void refresh()
}

// The three answers' shared shape, read together below.
function readAnswers(): [ActiveGoalsOutput | null, InProgressTasksOutput | null, LatestHandoffOutput | null] {
  return [read(goalsResult), read(tasksResult), read(handoffResult)]
}

/** Nothing has been read yet — the first request set is still out. */
function nothingReadYet(): boolean {
  return readAnswers().every((answer) => answer === null)
}

/** Every group refused: temper was never reached, so no group claims anything. */
function allRefused(): boolean {
  return readAnswers().every((answer) => answer !== null && !answer.connected)
}

/**
 * The signed-out refusal, shared by whichever tab holds: nothing here was read, on any tab.
 */
function Refusal() {
  const [goals, tasks, handoff] = readAnswers()
  if (
    goals === null || goals.connected ||
    tasks === null || tasks.connected ||
    handoff === null || handoff.connected
  ) {
    return undefined
  }
  return <EmptyState title="temper is not connected" description={goals.message} icon="warning" />
}

/** The loading region, for every tab: reads happen once, on the panel's behalf. */
function LoadingRegion() {
  return (
    <Row gap="sm" align="center">
      {read(loading) ? <Spinner label="Reading temper" labelHidden /> : undefined}
      <Text muted>◌ Loading …</Text>
    </Row>
  )
}

/**
 * One list group: a counted heading, the contexts it read, its rows or its empty text. Rows
 * open a detail view in the panel; the doc-type word leads each row's description — no icons.
 */
function ResourceList(props: {
  label: string
  docType: 'goal' | 'task'
  count: number
  contexts: string[]
  items: ResourceSummary[]
  empty: string
  truncatedNotice: string | null
}) {
  return (
    <Stack gap="sm">
      <Heading>{`${props.label} (${props.count})`}</Heading>
      <Text muted size="xs">
        {props.contexts.join(', ')}
      </Text>
      {props.items.length === 0 ? (
        <Text muted size="xs">
          {props.empty}
        </Text>
      ) : (
        <List label={props.label}>
          {props.items.map((item) => (
            <ListItem
              key={item.id}
              title={item.title}
              description={props.docType}
              onPress={() =>
                pushDetail({ id: item.id, ref: item.ref, title: item.title, docType: props.docType })
              }
            />
          ))}
        </List>
      )}
      {props.truncatedNotice === null ? undefined : (
        <Text muted size="xs">
          {props.truncatedNotice}
        </Text>
      )}
    </Stack>
  )
}

function GoalsGroup() {
  const goals = read(goalsResult)
  if (goals === null || !goals.connected || allRefused()) {
    return undefined
  }
  return (
    <ResourceList
      label="Active goals"
      docType="goal"
      count={goals.goals.length}
      contexts={goals.contexts}
      items={goals.goals}
      empty={`— No active goals in ${goals.contexts.join(', ')}.`}
      truncatedNotice={goals.truncated ? 'More goals than fit this page — narrow the context.' : null}
    />
  )
}

function TasksGroup() {
  const tasks = read(tasksResult)
  if (tasks === null || !tasks.connected || allRefused()) {
    return undefined
  }
  return (
    <ResourceList
      label="Tasks in progress"
      docType="task"
      count={tasks.tasks.length}
      contexts={tasks.contexts}
      items={tasks.tasks}
      empty={`— No tasks in progress in ${tasks.contexts.join(', ')}.`}
      truncatedNotice={tasks.truncated ? 'More tasks than fit this page — narrow the context.' : null}
    />
  )
}

function HandoffGroup() {
  const handoff = read(handoffResult)
  if (handoff === null || !handoff.connected || allRefused()) {
    return undefined
  }
  return (
    <Stack gap="sm">
      <Heading>{`Latest handoff (${handoff.handoff === null ? 0 : 1})`}</Heading>
      <Text muted size="xs">
        {handoff.contexts.join(', ')}
      </Text>
      {handoff.handoff === null ? (
        <Text muted size="xs">
          {`— No session notes in ${handoff.contexts.join(', ')}.`}
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
  )
}

/** A group the worker refused while others connected: the group's own ⚠ region. */
function GroupRefusal(props: { label: string; message: string }) {
  return (
    <Stack gap="sm">
      <Heading>{props.label}</Heading>
      <Text tone="warning">{`⚠ ${props.message}`}</Text>
    </Stack>
  )
}

function HomeTab() {
  const [goals, tasks, handoff] = readAnswers()
  if (nothingReadYet()) {
    // The loading region stands over the tabs; nothing else renders yet.
    return undefined
  }
  if (goals === null || tasks === null || handoff === null) {
    // Some answers still out while others landed: keep the loading region until all are in,
    // as before — no half-set of groups.
    return <LoadingRegion />
  }
  if (allRefused()) {
    // The refusal region above the tabs carries it; no group renders.
    return undefined
  }
  return (
    <Stack gap="md">
      {goals !== null && !goals.connected ? (
        <GroupRefusal label="Active goals" message={goals.message} />
      ) : (
        <GoalsGroup />
      )}
      {tasks !== null && !tasks.connected ? (
        <GroupRefusal label="Tasks in progress" message={tasks.message} />
      ) : (
        <TasksGroup />
      )}
      {handoff !== null && !handoff.connected ? (
        <GroupRefusal label="Latest handoff" message={handoff.message} />
      ) : (
        <HandoffGroup />
      )}
    </Stack>
  )
}

/**
 * Explore and Search hold until their build items land; each says so instead of pretending a
 * region. Neither draws a lens switcher — the sub-tab frame replaced it.
 */
function TabPlaceholder(props: { text: string }) {
  return (
    <Text muted size="sm">
      {props.text}
    </Text>
  )
}

/** The frame: the sub-tabs, the refusal standing over them, and the read region. */
function Frame() {
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Temper</Heading>
        <Button variant="ghost" icon="refresh" onPress={refresh} disabled={read(loading)}>
          Refresh
        </Button>
      </Row>
      {nothingReadYet() ? <LoadingRegion /> : <Refusal />}
      <Tabs
        label="temper view"
        value={read(activeTab)}
        onChange={(value) => set(activeTab, value)}
      >
        <Tab value="home" label="Home">
          <HomeTab />
        </Tab>
        <Tab value="explore" label="Explore">
          {allRefused() ? undefined : (
            <TabPlaceholder text="Explore arrives with a later iteration — teams, then their contexts." />
          )}
        </Tab>
        <Tab value="search" label="Search">
          {allRefused() ? undefined : (
            <TabPlaceholder text="Search arrives with a later iteration — exact and by-meaning matching." />
          )}
        </Tab>
      </Tabs>
    </Stack>
  )
}

/** A pushed detail view: back out, then the item's type word, title and ref. */
function DetailView(props: { entry: DetailEntry }) {
  return (
    <Stack gap="md">
      <Row>
        <Button variant="ghost" onPress={popDetail}>
          Back
        </Button>
      </Row>
      <Stack gap="sm">
        <Text muted size="xs">
          {props.entry.docType}
        </Text>
        <Heading>{props.entry.title}</Heading>
        <Text muted size="xs">
          {props.entry.ref}
        </Text>
      </Stack>
    </Stack>
  )
}

export default function Panel() {
  const stack = read(detailStack)
  const top = stack.length === 0 ? null : stack[stack.length - 1]
  return top === null ? <Frame /> : <DetailView entry={top} />
}
