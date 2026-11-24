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
// standing ways in with Show more, the places the person works in, and recently updated. Goals
// and Tasks each take a status toggle (ruling 24: active · completed; backlog · in progress · done),
// defaulting to the status temper-ui's home reads, so Home opens as temper-ui's does; the pick
// is device-local view state, and every status keeps the count, the omission sentence, Show
// more and the region states. A goal's linked tasks grow by the same Show more. Home opens on
// the "this workspace" strip (./serves-strip.tsx): the focused workspace, the task it serves
// and its agents. Explore (./explore.tsx) lists teams, each with its contexts; a pressed
// context — from Explore, or a place on Home — pushes the context view onto the same stack.
//
// Text is temper-design's job and is imported from it, never copied: the ways in, their bound
// and order (WAYS_IN, WAY_IN_BOUND, WAY_IN_ORDER), the omission sentences and HANDOFF_LABEL.
// Region states carry their own words (◌ loading over a skeleton, — empty with its count at 0,
// "unavailable — nothing here was read" as a warning callout's title, temper not connected as
// an empty state with the plug), and every list states its omission sentence and its order. Orca's controls carry the look (./look.ts): a row wears
// its doc-type icon beside the doc-type word, never instead of it; a region's count is a badge
// on its heading; a row's state is words in its description; the detail's state is a badge
// holding its word; one solid accent act per view, the rest outlined or ghost.
import {
  atom,
  Badge,
  Box,
  Button,
  Card,
  Collapsible,
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
  Skeleton,
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
import {
  DetailLaunchButton,
  DetailLaunchConsent,
  HandoffLaunchButton,
  LauncherSheet,
  loadItemLinks,
  ReopenButtons,
  ReopenConsent,
  ReopenOutcome,
  setupLauncher
} from './launcher'
import { cardLaunchLabel, HandoffTasks, loadHandoffTasks } from './handoff-card'
import { loadWorkRecords, WorkRegion } from './work-region'
import { OpenBodyAnswer, OpenBodyButton, OpenBodyConsent } from './editor-room/open-body-action'
import { loadSkillReadiness, SkillReadinessRegion } from './skill-readiness/region'
import { refreshServes, ServesRegion, setupServes } from './serves-strip'
import {
  type ContextEntry,
  ContextView,
  exploreWasAsked,
  ExploreTab,
  isContextEntry,
  loadContextRecent,
  loadExplore
} from './explore'
import { CountHeading, FailedRegion, Loading, NotConnected, Unavailable } from './regions'
import {
  ACT_ICON,
  docTypeIcon,
  metaItems,
  PLACE_ICON,
  recordState,
  rowDescription,
  stateTone,
  stateWord
} from './look'
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
import { LINKED_TASKS_BOUND, WAY_IN_MAX } from './protocol'
import { WAY_TOGGLES, type WayToggle } from './way-status'

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
/**
 * The status each toggled way in is read by, device-local view state held across the panel's
 * runs as the detail stack is: absent, a way reads its WAYS_IN default.
 */
const wayInStatus = atom('way-in-status', {} as Record<string, string>, { persist: 'plugin' })
/** True while the first refresh is out. */
const loading = atom('loading', false)

/** Which sub-tab holds — device-local view state, held across the panel's runs (Rulings Q2). */
const activeTab = atom('active-tab', 'home', { persist: 'plugin' })

/** One pushed detail view: the item's identity and the doc-type word it is. */
interface DetailEntry {
  id: string
  ref: string
  title: string
  docType: string
}

/** The in-panel detail stack: pressing an item or a context pushes, Back pops. Held here, in
 * full, across the panel's runs within this Orca session — device-local view state (Rulings
 * Q2), so the rail reopens where the person was, and a check run can stand a detail up from a
 * seeded run. A record's entry carries no `kind`; a context's carries `kind: 'context'`. */
const detailStack = atom('detail-stack', [] as (DetailEntry | ContextEntry)[], { persist: 'plugin' })

/** The detail's answer per pushed id, null while its request is out. */
const detailResults = atom('detail-results', {} as Record<string, RecordDetailOutput | null>)
/** A goal's linked-tasks answer per goal id, null while its request is out. */
const linkedTaskResults = atom('linked-task-results', {} as Record<string, LinkedTasksOutput | null>)
/** How far each goal's linked tasks have grown: a step of WAY_IN_BOUND at a Show-more press. */
const linkedTasksShown = atom('linked-tasks-shown', {} as Record<string, number>)
/** The person's "Temper web address" setting, as the plugin holds it now; null until read. */
const webUrlSetting = atom('web-url-setting', null as string | null)

function pushDetail(entry: DetailEntry): void {
  set(detailStack, [...read(detailStack), entry])
  loadDetail(entry)
  loadLinkedTasks(entry)
  void loadItemLinks(entry.id)
  if (entry.docType === 'task') {
    void loadWorkRecords(entry.id)
  }
}

/** A pressed context — from Explore, or a place on Home — pushes the context view. */
function pushContext(entry: ContextEntry): void {
  set(detailStack, [...read(detailStack), entry])
  void loadContextRecent(entry)
}

/** A row in the context view opens its record's detail, on top of the context. */
function openSummary(item: ResourceSummary): void {
  pushDetail({ id: item.id, ref: item.ref, title: item.title, docType: item.docType })
}

/** The sub-tab picked; Explore reads its contexts the first time it is shown. */
function pickTab(value: string): void {
  set(activeTab, value)
  if (value === 'explore' && !exploreWasAsked() && !allRefused()) {
    void loadExplore()
  }
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
      bound: linkedTasksBound(entry.id)
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

/** The bound a goal's linked tasks are asked at: the default, or where Show more carried it. */
function linkedTasksBound(goalId: string): number {
  return read(linkedTasksShown)[goalId] ?? LINKED_TASKS_BOUND
}

/** Show more on a goal's linked tasks: the ways-in step and cap, grown in place. */
async function showMoreLinked(goalId: string): Promise<void> {
  const bound = Math.min(linkedTasksBound(goalId) + WAY_IN_BOUND, WAY_IN_MAX)
  set(linkedTasksShown, { ...read(linkedTasksShown), [goalId]: bound })
  let answer: LinkedTasksOutput
  try {
    answer = await plugin.request('temper.goal.tasks', { id: goalId, bound })
  } catch (error) {
    answer = {
      state: 'failed',
      message: `the linked-tasks read never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(linkedTaskResults, { ...read(linkedTaskResults), [goalId]: answer })
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

/** The status a toggled way in is read by: the person's pick, else its default. */
function wayInStatusOf(id: string): string | undefined {
  const toggle = WAY_TOGGLES[id]
  if (toggle === undefined) {
    return undefined
  }
  const picked = read(wayInStatus)[id]
  return toggle.statuses.some((status) => status.value === picked) ? picked : toggle.defaultStatus
}

/**
 * Each way's newest ask: an answer to an older one (a status picked, then another before the
 * first answered) is dropped, so a list never shows rows of a status the toggle no longer holds.
 */
const wayInAsks: Record<string, number> = {}

/** One way in, asked at its current bound and status; null when a newer ask superseded it. */
async function askWayIn(id: string): Promise<WayInOutput | null> {
  const ask = (wayInAsks[id] ?? 0) + 1
  wayInAsks[id] = ask
  const status = wayInStatusOf(id)
  const answer = await plugin.request(
    'temper.home.way-in',
    status === undefined ? { id, bound: wayInBound(id) } : { id, bound: wayInBound(id), status }
  )
  return wayInAsks[id] === ask ? answer : null
}

async function refresh(): Promise<void> {
  set(loading, true)
  // Agent skill readiness reads beside temper's regions, on its own: no grant rides it.
  void loadSkillReadiness()
  refreshServes()
  try {
    const [resume, handoff, places, recent, ...ways] = await Promise.all([
      plugin.request('temper.home.resume'),
      plugin.request('temper.home.handoff'),
      plugin.request('temper.home.places'),
      plugin.request('temper.home.recent'),
      ...WAYS_IN.map((way) => askWayIn(way.id))
    ])
    set(resumeResult, resume)
    set(handoffResult, handoff)
    // The tasks the latest session advanced, with their stages from temper — read beside the card.
    if (handoff.state === 'ok' && handoff.handoff !== null) {
      void loadHandoffTasks(handoff.handoff.id)
    }
    set(placesResult, places)
    set(recentResult, recent)
    const results: Record<string, WayInOutput | null> = { ...read(wayInResults) }
    WAYS_IN.forEach((way, index) => {
      const answer = ways[index]
      if (answer !== null && answer !== undefined) {
        results[way.id] = answer
      }
    })
    set(wayInResults, results)
    // Explore reads only once it is shown — it is not Home's read — and never into a refusal
    // that stands over every tab. A run that reopens on Explore owes its read here.
    if ((exploreWasAsked() || read(activeTab) === 'explore') && !allRefused()) {
      void loadExplore()
    }
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
  const answer = await askWayIn(id)
  if (answer !== null) {
    set(wayInResults, { ...read(wayInResults), [id]: answer })
  }
}

/**
 * A status picked on a toggled way: the list starts over at the default bound under the new
 * status, its region still out until the read answers.
 */
async function pickStatus(id: string, status: string): Promise<void> {
  if (wayInStatusOf(id) === status) {
    return
  }
  set(wayInStatus, { ...read(wayInStatus), [id]: status })
  const shown = { ...read(wayInShown) }
  delete shown[id]
  set(wayInShown, shown)
  set(wayInResults, { ...read(wayInResults), [id]: null })
  const answer = await askWayIn(id)
  if (answer !== null) {
    set(wayInResults, { ...read(wayInResults), [id]: answer })
  }
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
  if (carried !== undefined && isContextEntry(carried)) {
    void loadContextRecent(carried)
  } else if (carried !== undefined) {
    void loadDetail(carried)
    void loadLinkedTasks(carried)
    void loadItemLinks(carried.id)
    if (carried.docType === 'task') {
      void loadWorkRecords(carried.id)
    }
  }
  setupLauncher()
  setupServes(ctx)
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
  return <NotConnected message={refusalMessage()} />
}

/** The loading region, for every tab: reads happen once, on the panel's behalf. */
function LoadingRegion() {
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center">
        {read(loading) ? <Spinner label="Reading temper" labelHidden /> : undefined}
        <Text muted>◌ Loading …</Text>
      </Row>
      <Skeleton lines={3} label="Reading temper" />
    </Stack>
  )
}

/**
 * One resource row: its doc-type icon, and the doc-type word leading its description — with the
 * row's state in words unless the list's own heading already says it (`stateless`).
 */
function ResourceRow(props: { item: ResourceSummary; description?: string; stateless?: boolean }) {
  const item = props.item
  return (
    <ListItem
      title={item.title}
      icon={docTypeIcon(item.docType)}
      description={
        props.description ??
        (props.stateless === true ? item.docType : rowDescription(item.docType, item.stage))
      }
      onPress={() =>
        pushDetail({ id: item.id, ref: item.ref, title: item.title, docType: item.docType })
      }
    />
  )
}

/**
 * One region's shell: its own state — still out, failed, refused (drawn over by the panel's
 * refusal, so not here) or answered. The children render the answered case. Exported for the
 * region-state witness, which stands one up still out.
 */
export function Region(props: {
  answer: { state: string } | null
  label: string
  children?: OrcaNode
}): OrcaNode {
  const answer = props.answer
  if (answer === null) {
    return (
      <Stack gap="sm">
        <Heading level={3}>{props.label}</Heading>
        <Loading words={`◌ Loading ${props.label}…`} />
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
              icon={docTypeIcon(resume.resource.docType)}
              description={rowDescription(resume.resource.docType, resume.resource.stage)}
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
          {handoff === null ? (
            <Stack gap="sm">
              <Heading level={3}>{HANDOFF_LABEL}</Heading>
              <Text muted size="xs">{`— No ${sessionScope}.`}</Text>
            </Stack>
          ) : (
            <Card title={HANDOFF_LABEL}>
              <Stack gap="sm">
                <List label={HANDOFF_LABEL}>
                  <ListItem
                    title={handoff.title}
                    icon={docTypeIcon('session')}
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
                <HandoffTasks sessionId={handoff.id} onOpen={pushDetail} />
                {handoff.next === null ? undefined : (
                  <Box background="muted" radius="sm" padding="sm" gap="xs">
                    <Text muted size="xs">{`excerpt · ${handoff.next.heading}`}</Text>
                    <Text>{handoff.next.text}</Text>
                    {handoff.next.truncated ? (
                      <Text muted size="xs">
                        … continues in the session.
                      </Text>
                    ) : undefined}
                  </Box>
                )}
                <Row>
                  <HandoffLaunchButton handoff={handoff} label={cardLaunchLabel(handoff.id)} />
                </Row>
                <Text muted size="xs">
                  {omissionSentence(answer.sessionCount, 1, sessionScope)}
                </Text>
              </Stack>
            </Card>
          )}
          {/* The sheet opens below the card, after its omission sentence — never between them. */}
          {handoff === null ? undefined : <LauncherSheet from="home" itemId={handoff.id} />}
        </Stack>
      )}
    </Region>
  )
}

/** An answered way in's body: its order, its rows, what it omits, and Show more in place. */
function WayInBody(props: { id: string; name: string; answer: WayInOutput & { state: 'ok' } }) {
  const answer = props.answer
  return (
    <Stack gap="sm">
      <Text muted size="xs">
        {WAY_IN_ORDER}
      </Text>
      {answer.rows.length === 0 ? (
        <Text muted size="xs">{`— No ${answer.scope}.`}</Text>
      ) : (
        <List label={props.name}>
          {answer.rows.map((item) => (
            <ResourceRow key={item.id} item={item} stateless />
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
          <Button
            variant="ghost"
            size="sm"
            icon={ACT_ICON.showMore}
            onPress={() => void showMore(props.id)}
          >
            Show more
          </Button>
        </Row>
      ) : undefined}
    </Stack>
  )
}

/**
 * A toggled way's status control: Orca's own `Tabs`, one tab per status, the selected one
 * holding the region's body — the list, or its loading or failed state.
 */
function StatusToggle(props: { id: string; toggle: WayToggle; children?: OrcaNode }) {
  const selected = wayInStatusOf(props.id) ?? props.toggle.defaultStatus
  return (
    <Tabs
      label={`${props.toggle.name} by ${props.toggle.key}`}
      value={selected}
      onChange={(value) => void pickStatus(props.id, value)}
    >
      {props.toggle.statuses.map((status) => (
        <Tab key={status.value} value={status.value} label={status.label}>
          {status.value === selected ? props.children : undefined}
        </Tab>
      ))}
    </Tabs>
  )
}

/**
 * One way in: its name, its count a badge for the status it shows, its order stated, Show more
 * in place. Goals and Tasks carry their status toggle under the heading in every region state.
 */
function WayInRegion(props: { id: string }) {
  const toggle = WAY_TOGGLES[props.id]
  const label = toggle?.name ?? WAYS_IN.find((way) => way.id === props.id)?.label ?? props.id
  const answer = read(wayInResults)[props.id] ?? null
  if (toggle === undefined) {
    return (
      <Region answer={answer} label={label}>
        {answer !== null && answer.state === 'ok' ? (
          <Stack gap="sm">
            <CountHeading label={answer.label} count={answer.total} />
            <WayInBody id={props.id} name={label} answer={answer} />
          </Stack>
        ) : undefined}
      </Region>
    )
  }
  if (answer !== null && answer.state === 'not-connected') {
    return undefined
  }
  return (
    <Stack gap="sm">
      {answer !== null && answer.state === 'ok' ? (
        <CountHeading label={label} count={answer.total} />
      ) : (
        <Heading level={3}>{label}</Heading>
      )}
      <StatusToggle id={props.id} toggle={toggle}>
        {answer === null ? (
          <Loading words={`◌ Loading ${label}…`} />
        ) : answer.state === 'failed' ? (
          <Unavailable title={`${label} unavailable — nothing here was read.`} message={answer.message} />
        ) : answer.state === 'ok' ? (
          <WayInBody id={props.id} name={label} answer={answer} />
        ) : undefined}
      </StatusToggle>
    </Stack>
  )
}

/** Places: the contexts the person changed something in, by their own latest change in each;
 *  a pressed place opens the same context view Explore opens. */
function PlacesRegion() {
  const answer = read(placesResult)
  return (
    <Region answer={answer} label="places">
      {answer !== null && answer.state === 'ok' ? (
        <Stack gap="sm">
          <CountHeading label="places" count={answer.total} />
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
                  icon={PLACE_ICON}
                  description={place.ref}
                  onPress={() =>
                    pushContext({ kind: 'context', id: place.id, ref: place.ref, name: place.name })
                  }
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
          <CountHeading label="recently updated" count={answer.total} />
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
                    item.contextRef === null
                      ? rowDescription(item.docType, item.stage)
                      : `${rowDescription(item.docType, item.stage)} · ${item.contextRef}`
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
      <ServesRegion onOpen={pushDetail} />
      <ResumeRegion />
      <HandoffRegion />
      {WAYS_IN.map((way) => (
        <WayInRegion key={way.id} id={way.id} />
      ))}
      <RecentRegion />
      <PlacesRegion />
      <SkillReadinessRegion />
    </Stack>
  )
}

/**
 * Search holds until its build item lands; it says so instead of pretending a region. No tab
 * draws a lens switcher — the sub-tab frame replaced it.
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
        <Button variant="ghost" icon={ACT_ICON.refresh} onPress={refresh} disabled={read(loading)}>
          Refresh
        </Button>
      </Row>
      {nothingReadYet() ? <LoadingRegion /> : <Refusal />}
      <Tabs
        label="temper view"
        value={read(activeTab)}
        onChange={pickTab}
      >
        <Tab value="home" label="Home">
          <HomeTab />
        </Tab>
        <Tab value="explore" label="Explore">
          {allRefused() ? undefined : <ExploreTab onOpenContext={pushContext} />}
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

/**
 * A pushed detail view: out, refused, failed, or answered. The header names the doc type, the
 * record's state as a badge holding its word, and the title; the acts stand in one row — the
 * launcher press the one solid accent act, Reopen agent (where a link carries a session), Open
 * body and Open in temper outlined — with the
 * launcher's sheet under them; the meta closes the view, collapsed.
 */
function DetailView(props: { entry: DetailEntry }) {
  const answer = read(detailResults)[props.entry.id] ?? null
  const ok = answer !== null && answer.state === 'ok'
  const detail = ok ? answer.detail : null
  const state = detail === null ? null : recordState(detail)
  return (
    <Stack gap="md">
      <Row>
        <Button variant="ghost" size="sm" onPress={popDetail}>
          Back
        </Button>
      </Row>
      <Stack gap="xs">
        <Row gap="xs" align="center">
          <Text muted size="xs">
            {props.entry.docType}
          </Text>
          {state === null ? undefined : <Badge tone={stateTone(state)}>{stateWord(state)}</Badge>}
        </Row>
        <Heading level={2}>{detail === null ? props.entry.title : detail.title}</Heading>
      </Stack>
      <Stack gap="xs">
        <Row gap="xs" wrap>
          {detail === null ? undefined : <DetailLaunchButton detail={detail} />}
          {detail === null ? undefined : <ReopenButtons detail={detail} />}
          <OpenBodyButton id={props.entry.id} named={false} />
          <WayOutButton id={props.entry.id} />
        </Row>
        {detail === null ? undefined : <DetailLaunchConsent detail={detail} />}
        {detail === null ? undefined : <ReopenConsent detail={detail} />}
        <ReopenOutcome itemId={props.entry.id} />
        <OpenBodyConsent />
        <OpenBodyAnswer id={props.entry.id} />
        <WayOutNote id={props.entry.id} />
      </Stack>
      {detail === null ? undefined : <LauncherSheet from="detail" itemId={props.entry.id} />}
      {detail === null ? undefined : <WorkRegion detail={detail} />}
      <RecordDetailRegion answer={answer} />
      {props.entry.docType === 'goal' && (answer === null || answer.state !== 'not-connected') ? (
        <LinkedTasksRegion goal={props.entry} />
      ) : undefined}
    </Stack>
  )
}

/** The meta region of a pushed detail: its own state, then the rows in temper-ui's order. */
function RecordDetailRegion(props: { answer: RecordDetailOutput | null }) {
  const answer = props.answer
  if (answer === null) {
    return <Loading words="◌ Loading the record…" />
  }
  if (answer.state === 'not-connected') {
    // The signed-out refusal: no item data answers it on any surface.
    return <NotConnected message={answer.message} />
  }
  if (answer.state === 'failed') {
    return <Unavailable title="the record is unavailable — nothing here was read." message={answer.message} />
  }
  const items = metaItems(answer.detail)
  return (
    <Collapsible title="meta" description={items.map((item) => item.label).join(', ')}>
      <KeyValue label="meta" items={items} />
    </Collapsible>
  )
}

/** A goal's linked tasks: the `advances` edges, labelled "linked tasks", never "all tasks". */
const LINKED_TASKS_SCOPE = 'linked tasks'

function LinkedTasksRegion(props: { goal: DetailEntry }) {
  const answer = read(linkedTaskResults)[props.goal.id] ?? null
  if (answer === null) {
    return <Loading words={`◌ Loading ${LINKED_TASKS_SCOPE}…`} />
  }
  if (answer.state === 'not-connected') {
    return undefined
  }
  if (answer.state === 'failed') {
    return <FailedRegion label={LINKED_TASKS_SCOPE} message={answer.message} />
  }
  return (
    <Stack gap="sm">
      <CountHeading label={LINKED_TASKS_SCOPE} count={answer.total} />
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
          {answer.rows.length < answer.total && answer.bound < WAY_IN_MAX ? (
            <Row>
              <Button
                variant="ghost"
                size="sm"
                icon={ACT_ICON.showMore}
                onPress={() => void showMoreLinked(props.goal.id)}
              >
                Show more
              </Button>
            </Row>
          ) : undefined}
        </Stack>
      )}
    </Stack>
  )
}

/** The way out: opens the record in temper through the person's web-address setting. A
 *  secondary act, outlined; disabled, and named under the row, while the setting is unset. */
function WayOutButton(props: { id: string }) {
  const url = wayOutUrl(read(webUrlSetting), props.id)
  return url === null ? (
    <Button disabled variant="outline" icon={ACT_ICON.openInTemper}>
      Open in temper
    </Button>
  ) : (
    <Button variant="outline" icon={ACT_ICON.openInTemper} onPress={() => void openInTemper(url)}>
      Open in temper
    </Button>
  )
}

/** What the way out is for, and — while it cannot open — the setting that lights it. */
function WayOutNote(props: { id: string }) {
  const url = wayOutUrl(read(webUrlSetting), props.id)
  return (
    <Stack gap="xs">
      <Text muted size="xs">The full record opens in temper — only the meta shows here.</Text>
      {url === null ? (
        <Text muted size="xs">
          Set 'Temper web address' in the plugin's settings — the address is never guessed.
        </Text>
      ) : undefined}
    </Stack>
  )
}

export default function Panel() {
  const stack = read(detailStack)
  const top = stack.length === 0 ? null : stack[stack.length - 1]
  if (top === null || top === undefined) {
    return <Frame />
  }
  return isContextEntry(top) ? (
    <ContextView entry={top} onBack={popDetail} onOpenItem={openSummary} />
  ) : (
    <DetailView entry={top} />
  )
}
