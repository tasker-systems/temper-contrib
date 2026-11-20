// No build step: Orca strips the types and compiles the JSX when the panel loads. The rail is
// one panel: Home / Explore / Search sub-tabs on top, and a detail stack in an atom underneath
// — pressing an item pushes a detail view inside the same panel (no Orca method opens another
// panel), Back pops it. The detail shows the item's meta in temper-ui's order and its way out,
// never its body: the record read asks no sections, so no body crosses the read, and a muted
// line says the full record opens in temper. On a goal it lists the linked tasks the `advances`
// edges recorded — pressing one pushes its detail. The way out is the "Temper web address"
// setting the person sets (`webUrl`): press it and Orca opens `<webUrl>/vault/r/<id>` in the
// browser, over https only, never derived from the API origin. The panel never talks to temper
// itself — the worker does, on the borrowed grant — and Home mirrors temper-ui's home for the
// same person, list by list: resume, the latest handoff with its Next section quoted (plain
// text, as the surfaces render it — never temper-design's `sanitize`, which needs a DOM), the
// standing ways in with Show more, the places the person works in, and recently updated.
//
// Text is temper-design's job and is imported from it, never copied: the ways in, their bound
// and order (WAYS_IN, WAY_IN_BOUND, WAY_IN_ORDER), the omission sentences and HANDOFF_LABEL.
// Region states carry their own words (◌ loading, — empty, ⚠ failed), the doc-type word
// appears on rows instead of icons, and every list states its omission sentence and its order.
import {
  atom,
  Button,
  EmptyState,
  Heading,
  host,
  KeyValue,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  settings,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  type OrcaNode,
  type PanelContext
} from 'orca'
import {
  HANDOFF_LABEL,
  omissionSentence,
  WAY_IN_BOUND,
  WAY_IN_ORDER,
  WAYS_IN
} from '../vendor/temper-design.mjs'
import { refreshGrantedCapabilities } from './capabilities'
import { DetailLaunchActions, HandoffLaunchAction } from './launcher'
import { OpenBodyAction } from './editor-room/open-body-action'
import type {
  LatestHandoffOutput,
  LinkedTasksOutput,
  PlacesOutput,
  RecentOutput,
  RecordDetailOutput,
  RegionFailure,
  ResourceSummary,
  ResumeOutput,
  WayInOutput
} from './protocol'
import { LINKED_TASKS_BOUND } from './protocol'

// Interim, ruled by Pete 2026-11-20: temper-design does not yet export the Show-more cap
// (WAY_IN_MAX lives only in temper-ui's first-view), so Home ships this local constant until
// the follow-up task "orca-temper imports the Show-more cap from temper-design" swaps it for
// the package's export.
const WAY_IN_MAX = 200

/** Where a way in starts from, and what recently updated and places cover, in their own words. */
const RECENT_SCOPE = 'resources you can read'
const PLACES_SCOPE = 'places you changed something in'
const PLACES_ORDER = 'by your latest change in each'

/** The worker's last answers; null while each request is out. */
const resumeResult = atom<ResumeOutput | null>(null)
const handoffResult = atom<LatestHandoffOutput | null>(null)
const placesResult = atom<PlacesOutput | null>(null)
const recentResult = atom<RecentOutput | null>(null)
const wayInResults = atom('way-in-results', {} as Record<string, WayInOutput | null>)
/** How far each way in has grown, device-local view state: a step of WAY_IN_BOUND at a press. */
const wayInShown = atom('way-in-shown', {} as Record<string, number>)
/** True while the first refresh is out. */
const loading = atom('loading', false)

/** Which sub-tab holds. */
const activeTab = atom('active-tab', 'home')

/** One pushed detail view: the item's identity and the doc-type word it is. */
interface DetailEntry {
  id: string
  ref: string
  title: string
  docType: string
}

/** The in-panel detail stack: pressing an item pushes, Back pops. Held here, in full, across
 * the panel's runs within this Orca session — device-local view state (Rulings Q2), so the
 * rail reopens where the person was, and a check run can stand a detail up from a seeded run. */
const detailStack = atom('detail-stack', [] as DetailEntry[], { persist: 'plugin' })

/** The detail's answer per pushed id, null while its request is out. */
const detailResults = atom('detail-results', {} as Record<string, RecordDetailOutput | null>)
/** A goal's linked-tasks answer per goal id, null while its request is out. */
const linkedTaskResults = atom('linked-task-results', {} as Record<string, LinkedTasksOutput | null>)
/** The person's "Temper web address" setting, as the plugin holds it now; null until read. */
const webUrlSetting = atom('web-url-setting', null as string | null)

function pushDetail(entry: DetailEntry): void {
  set(detailStack, [...read(detailStack), entry])
  loadDetail(entry)
  loadLinkedTasks(entry)
}

function popDetail(): void {
  set(detailStack, read(detailStack).slice(0, -1))
}

/** The record read behind one pushed entry, once per id — null marks the request as out. */
async function loadDetail(entry: DetailEntry): Promise<void> {
  if (read(detailResults)[entry.id] !== undefined) {
    return
  }
  set(detailResults, { ...read(detailResults), [entry.id]: null })
  try {
    const answer = await plugin.request('temper.resource.detail', { id: entry.id })
    set(detailResults, { ...read(detailResults), [entry.id]: answer })
  } catch (error) {
    set(detailResults, {
      ...read(detailResults),
      [entry.id]: {
        state: 'failed',
        message: `the record read never answered: ${error instanceof Error ? error.message : String(error)}`
      }
    })
  }
}

/** The linked-tasks read behind a goal, once per id. A non-goal takes no read at all. */
async function loadLinkedTasks(entry: DetailEntry): Promise<void> {
  if (entry.docType !== 'goal') {
    return
  }
  if (read(linkedTaskResults)[entry.id] !== undefined) {
    return
  }
  set(linkedTaskResults, { ...read(linkedTaskResults), [entry.id]: null })
  try {
    const answer = await plugin.request('temper.goal.tasks', {
      id: entry.id,
      bound: LINKED_TASKS_BOUND
    })
    set(linkedTaskResults, { ...read(linkedTaskResults), [entry.id]: answer })
  } catch (error) {
    set(linkedTaskResults, {
      ...read(linkedTaskResults),
      [entry.id]: {
        state: 'failed',
        message: `the linked-tasks read never answered: ${error instanceof Error ? error.message : String(error)}`
      }
    })
  }
}

/**
 * The way out opens through the person's own setting, over https only, and is never derived
 * from the API origin (they differ: the API is not where temper-ui is served). Unset, not
 * https://, or a bare `https://` hostless value: null, and the button names the setting.
 */
function wayOutBase(setting: string | null | undefined): string | null {
  if (typeof setting !== 'string') {
    return null
  }
  const trimmed = setting.trim()
  if (!/^https:\/\/[^\s/]+/.test(trimmed)) {
    return null
  }
  return trimmed.replace(/\/+$/, '')
}

function wayOutUrl(setting: string | null | undefined, id: string): string | null {
  const base = wayOutBase(setting)
  return base === null ? null : `${base}/vault/r/${id}`
}

/** Opens the way out in the person's browser; Orca asks the person once per new host. */
async function openInTemper(url: string): Promise<void> {
  await host.call('shell.openExternal', { url })
}

/** The bound a way in is currently asked at: the default, or where Show more carried it. */
function wayInBound(id: string): number {
  return read(wayInShown)[id] ?? WAY_IN_BOUND
}

async function refresh(): Promise<void> {
  set(loading, true)
  try {
    const [resume, handoff, places, recent, ...ways] = await Promise.all([
      plugin.request('temper.home.resume'),
      plugin.request('temper.home.handoff'),
      plugin.request('temper.home.places'),
      plugin.request('temper.home.recent'),
      ...WAYS_IN.map((way) =>
        plugin.request('temper.home.way-in', { id: way.id, bound: wayInBound(way.id) })
      )
    ])
    set(resumeResult, resume)
    set(handoffResult, handoff)
    set(placesResult, places)
    set(recentResult, recent)
    const results: Record<string, WayInOutput | null> = {}
    WAYS_IN.forEach((way, index) => {
      results[way.id] = ways[index] ?? null
    })
    set(wayInResults, results)
    // The consents ride along so actions draw lit or named from the start.
    await refreshGrantedCapabilities()
  } finally {
    set(loading, false)
  }
}

/** Show more: grow the one list in place by the shared step, up to its cap — never a grid. */
async function showMore(id: string): Promise<void> {
  const bound = Math.min(wayInBound(id) + WAY_IN_BOUND, WAY_IN_MAX)
  set(wayInShown, { ...read(wayInShown), [id]: bound })
  const answer = await plugin.request('temper.home.way-in', { id, bound })
  set(wayInResults, { ...read(wayInResults), [id]: answer })
}

/** Runs once before the first render. */
export function setup(ctx: PanelContext): void {
  // The way-out setting, read once and followed as the person changes it.
  void settings
    .get('webUrl')
    .then((value) => set(webUrlSetting, typeof value === 'string' ? value : null))
  ctx.subscriptions.push(
    settings.onDidChange((change) => {
      if (change.key === 'webUrl') {
        void settings
          .get('webUrl')
          .then((value) => set(webUrlSetting, typeof value === 'string' ? value : null))
      }
    })
  )
  // A detail stack carried over from the panel's last run (device-local view state) owes its
  // reads: the entry arrived without the panel pressing it, so its loads must fire here.
  const carried = read(detailStack)[read(detailStack).length - 1]
  if (carried !== undefined) {
    void loadDetail(carried)
    void loadLinkedTasks(carried)
  }
  void refresh()
}

/** Every region's answer, read together below. */
function readAnswers(): (ResumeOutput | LatestHandoffOutput | PlacesOutput | RecentOutput | WayInOutput | null)[] {
  const ways = read(wayInResults)
  return [
    read(resumeResult),
    read(handoffResult),
    read(placesResult),
    read(recentResult),
    ...WAYS_IN.map((way) => ways[way.id] ?? null)
  ]
}

/** Nothing has been read yet — the first request set is still out. */
function nothingReadYet(): boolean {
  return readAnswers().every((answer) => answer === null)
}

/** Every settled region refused the grant: temper was never reached, so no region claims it. */
function allRefused(): boolean {
  const answers = readAnswers().filter((answer) => answer !== null)
  return answers.length > 0 && answers.every((answer) => answer.state === 'not-connected')
}

/** The refusal message any refused region carries — they share the one credential strategy. */
function refusalMessage(): string {
  const refused = readAnswers().find((answer) => answer !== null && answer.state === 'not-connected')
  return refused !== null && refused !== undefined && refused.state === 'not-connected'
    ? refused.message
    : 'temper is not connected'
}

/**
 * The signed-out refusal, shared by whichever tab holds: nothing here was read, on any tab.
 */
function Refusal() {
  if (!allRefused()) {
    return undefined
  }
  return <EmptyState title="temper is not connected" description={refusalMessage()} icon="warning" />
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

/** A region whose read failed: it names what failed and shows nothing in its place. */
function FailedRegion(props: { label: string; message: string }) {
  return (
    <Stack gap="xs">
      <Heading level={3}>{props.label}</Heading>
      <Text tone="warning">{`⚠ ${props.label} unavailable — nothing here was read.`}</Text>
      <Text muted size="xs">
        {props.message}
      </Text>
    </Stack>
  )
}

/** One resource row: the doc-type word leads its description — no icons. */
function ResourceRow(props: { item: ResourceSummary; description?: string }) {
  const item = props.item
  return (
    <ListItem
      title={item.title}
      description={props.description ?? item.docType}
      onPress={() =>
        pushDetail({ id: item.id, ref: item.ref, title: item.title, docType: item.docType })
      }
    />
  )
}

/**
 * One region's shell: its own state — still out, failed, refused (drawn over by the panel's
 * refusal, so not here) or answered. The children render the answered case.
 */
function Region(props: {
  answer: { state: string } | null
  label: string
  children?: OrcaNode
}): OrcaNode {
  const answer = props.answer
  if (answer === null) {
    return (
      <Stack gap="sm">
        <Heading level={3}>{props.label}</Heading>
        <Text muted size="xs">{`◌ Loading ${props.label}…`}</Text>
      </Stack>
    )
  }
  if (answer.state === 'not-connected') {
    return undefined
  }
  if (answer.state === 'failed') {
    return <FailedRegion label={props.label} message={(answer as RegionFailure & { state: 'failed' }).message} />
  }
  return props.children
}

// The Start / Resume launcher lives in ./launcher.tsx; the detail view and Home place its
// buttons only, along the ruled table (Rulings: Where Start and Resume appear).

/** Resume: the one resource the person last changed — nothing stands in its place if none. */
function ResumeRegion() {
  const answer = read(resumeResult)
  const resume = answer !== null && answer.state === 'ok' ? answer.resume : null
  return (
    <Region answer={answer} label="resume">
      {resume === null ? undefined : (
        <Stack gap="sm">
          <Heading level={3}>resume</Heading>
          <Text muted size="xs">
            the one resource you last changed
          </Text>
          <List label="resume">
            <ListItem
              title={resume.resource.title}
              description={resume.resource.docType}
              onPress={() =>
                pushDetail({
                  id: resume.resource.id,
                  ref: resume.resource.ref,
                  title: resume.resource.title,
                  docType: resume.resource.docType
                })
              }
            >
              <Row gap="xs" align="center">
                <Text muted size="xs">
                  you changed it
                </Text>
                <RelativeTime at={Date.parse(resume.changedAt)} muted />
              </Row>
            </ListItem>
          </List>
        </Stack>
      )}
    </Region>
  )
}

/** The latest handoff, beside the lists as the desktop shows it: the session and its Next. */
function HandoffRegion() {
  const answer = read(handoffResult)
  const ok = answer !== null && answer.state === 'ok'
  const handoff = ok ? answer.handoff : null
  const sessionScope = WAYS_IN.find((way) => way.id === 'sessions')?.scope ?? 'sessions of yours'
  return (
    <Region answer={answer} label={HANDOFF_LABEL}>
      {answer === null || answer.state !== 'ok' ? undefined : (
        <Stack gap="sm">
          <Heading level={3}>{HANDOFF_LABEL}</Heading>
          {handoff === null ? (
            <Text muted size="xs">{`— No ${sessionScope}.`}</Text>
          ) : (
            <Stack gap="sm">
              <List label={HANDOFF_LABEL}>
                <ListItem
                  title={handoff.title}
                  description="session"
                  onPress={() =>
                    pushDetail({
                      id: handoff.id,
                      ref: handoff.ref,
                      title: handoff.title,
                      docType: 'session'
                    })
                  }
                />
              </List>
              {handoff.next === null ? undefined : (
                <Stack gap="xs">
                  <Text muted size="xs">{`excerpt · ${handoff.next.heading}`}</Text>
                  <Text>{handoff.next.text}</Text>
                  {handoff.next.truncated ? (
                    <Text muted size="xs">
                      … continues in the session.
                    </Text>
                  ) : undefined}
                </Stack>
              )}
              <HandoffLaunchAction handoff={handoff} />
              <Text muted size="xs">
                {omissionSentence(answer.sessionCount, 1, sessionScope)}
              </Text>
            </Stack>
          )}
        </Stack>
      )}
    </Region>
  )
}

/** One way in: its label and scope from WAYS_IN, its order stated, Show more in place. */
function WayInRegion(props: { id: string }) {
  const label = WAYS_IN.find((way) => way.id === props.id)?.label ?? props.id
  const answer = read(wayInResults)[props.id] ?? null
  return (
    <Region answer={answer} label={label}>
      {answer !== null && answer.state === 'ok' ? (
        <Stack gap="sm">
          <Heading level={3}>{`${answer.label} (${answer.total})`}</Heading>
          <Text muted size="xs">
            {WAY_IN_ORDER}
          </Text>
          {answer.rows.length === 0 ? (
            <Text muted size="xs">{`— No ${answer.scope}.`}</Text>
          ) : (
            <List label={answer.label}>
              {answer.rows.map((item) => (
                <ResourceRow key={item.id} item={item} />
              ))}
            </List>
          )}
          {answer.rows.length === 0 ? undefined : (
            <Text muted size="xs">
              {omissionSentence(answer.total, answer.rows.length, answer.scope)}
            </Text>
          )}
          {answer.rows.length < answer.total && answer.bound < WAY_IN_MAX ? (
            <Row>
              <Button variant="ghost" onPress={() => void showMore(props.id)}>
                Show more
              </Button>
            </Row>
          ) : undefined}
        </Stack>
      ) : undefined}
    </Region>
  )
}

/** Places: the contexts the person changed something in, by their own latest change in each. */
function PlacesRegion() {
  const answer = read(placesResult)
  return (
    <Region answer={answer} label="places">
      {answer !== null && answer.state === 'ok' ? (
        <Stack gap="sm">
          <Heading level={3}>{`places (${answer.total})`}</Heading>
          <Text muted size="xs">
            {PLACES_ORDER}
          </Text>
          {answer.rows.length === 0 ? (
            <Text muted size="xs">{`— No ${PLACES_SCOPE}.`}</Text>
          ) : (
            <List label="places">
              {answer.rows.map((place) => (
                <ListItem
                  key={place.ref}
                  title={place.name}
                  description={place.ref}
                >
                  <RelativeTime at={Date.parse(place.lastChangedAt)} muted />
                </ListItem>
              ))}
            </List>
          )}
          <Text muted size="xs">
            {omissionSentence(answer.total, answer.rows.length, PLACES_SCOPE)}
          </Text>
        </Stack>
      ) : undefined}
    </Region>
  )
}

/** Recently updated — across everything the person can read, and it says so. */
function RecentRegion() {
  const answer = read(recentResult)
  return (
    <Region answer={answer} label="recently updated">
      {answer !== null && answer.state === 'ok' ? (
        <Stack gap="sm">
          <Heading level={3}>{`recently updated (${answer.total})`}</Heading>
          <Text muted size="xs">
            {WAY_IN_ORDER}
          </Text>
          {answer.rows.length === 0 ? (
            <Text muted size="xs">{`— No ${RECENT_SCOPE}.`}</Text>
          ) : (
            <List label="recently updated">
              {answer.rows.map((item) => (
                <ResourceRow
                  key={item.id}
                  item={item}
                  description={
                    item.contextRef === null ? item.docType : `${item.docType} · ${item.contextRef}`
                  }
                />
              ))}
            </List>
          )}
          <Text muted size="xs">
            {omissionSentence(answer.total, answer.rows.length, RECENT_SCOPE)}
          </Text>
        </Stack>
      ) : undefined}
    </Region>
  )
}

function HomeTab() {
  if (nothingReadYet()) {
    // The loading region stands over the tabs; nothing else renders yet.
    return undefined
  }
  if (allRefused()) {
    // The refusal region above the tabs carries it; no region renders.
    return undefined
  }
  return (
    <Stack gap="md">
      <ResumeRegion />
      <HandoffRegion />
      {WAYS_IN.map((way) => (
        <WayInRegion key={way.id} id={way.id} />
      ))}
      <RecentRegion />
      <PlacesRegion />
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

/** A pushed detail view: out, refused, failed, or answered with its meta and its way out. */
function DetailView(props: { entry: DetailEntry }) {
  const answer = read(detailResults)[props.entry.id] ?? null
  const ok = answer !== null && answer.state === 'ok'
  const detail = ok ? answer.detail : null
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
        <Heading>{detail === null ? props.entry.title : detail.title}</Heading>
        <Text muted size="xs">
          {detail === null ? props.entry.ref : detail.ref}
        </Text>
      </Stack>
      <RecordDetailRegion answer={answer} fallbackRef={props.entry.ref} />
      {detail === null ? undefined : <DetailLaunchActions detail={detail} />}
      {props.entry.docType === 'goal' && (answer === null || answer.state !== 'not-connected') ? (
        <LinkedTasksRegion goal={props.entry} />
      ) : undefined}
      <OpenBodyAction id={props.entry.id} />
      <WayOut id={props.entry.id} />
    </Stack>
  )
}

/** The meta region of a pushed detail: its own state, then the rows in temper-ui's order. */
function RecordDetailRegion(props: { answer: RecordDetailOutput | null; fallbackRef: string }) {
  const answer = props.answer
  if (answer === null) {
    return <Text muted size="xs">◌ Loading the record…</Text>
  }
  if (answer.state === 'not-connected') {
    // The existing signed-out refusal: no item data answers it on any surface.
    return <EmptyState title="temper is not connected" description={answer.message} icon="warning" />
  }
  if (answer.state === 'failed') {
    return (
      <Stack gap="xs">
        <Text tone="warning">⚠ the record is unavailable — nothing here was read.</Text>
        <Text muted size="xs">{answer.message}</Text>
      </Stack>
    )
  }
  return <KeyValue label="meta" items={answer.detail.properties} />
}

/** A goal's linked tasks: the `advances` edges, labelled "linked tasks", never "all tasks". */
const LINKED_TASKS_SCOPE = 'linked tasks'

function LinkedTasksRegion(props: { goal: DetailEntry }) {
  const answer = read(linkedTaskResults)[props.goal.id] ?? null
  if (answer === null) {
    return <Text muted size="xs">◌ Loading {LINKED_TASKS_SCOPE}…</Text>
  }
  if (answer.state === 'not-connected') {
    return undefined
  }
  if (answer.state === 'failed') {
    return (
      <Stack gap="xs">
        <Text tone="warning">{`⚠ ${LINKED_TASKS_SCOPE} unavailable — nothing here was read.`}</Text>
        <Text muted size="xs">{answer.message}</Text>
      </Stack>
    )
  }
  return (
    <Stack gap="sm">
      <Heading level={3}>{`${LINKED_TASKS_SCOPE} (${answer.total})`}</Heading>
      {answer.rows.length === 0 ? (
        <Text muted size="xs">{`— No ${LINKED_TASKS_SCOPE}.`}</Text>
      ) : (
        <Stack gap="xs">
          <List label={LINKED_TASKS_SCOPE}>
            {answer.rows.map((task) => (
              <ResourceRow key={task.id} item={task} />
            ))}
          </List>
          <Text muted size="xs">
            {omissionSentence(answer.total, answer.rows.length, LINKED_TASKS_SCOPE)}
          </Text>
        </Stack>
      )}
    </Stack>
  )
}

/** The way out: opens the record in temper through the person's web-address setting. */
function WayOut(props: { id: string }) {
  const url = wayOutUrl(read(webUrlSetting), props.id)
  return (
    <Stack gap="xs">
      <Text muted size="xs">The full record opens in temper — only the meta shows here.</Text>
      {url === null ? (
        <Stack gap="xs">
          <Button disabled variant="outline">
            Open in temper
          </Button>
          <Text muted size="xs">
            Set 'Temper web address' in the plugin's settings — the address is never guessed.
          </Text>
        </Stack>
      ) : (
        <Button variant="outline" onPress={() => void openInTemper(url)}>
          Open in temper
        </Button>
      )}
    </Stack>
  )
}

export default function Panel() {
  const stack = read(detailStack)
  const top = stack.length === 0 ? null : stack[stack.length - 1]
  return top === null ? <Frame /> : <DetailView entry={top} />
}
