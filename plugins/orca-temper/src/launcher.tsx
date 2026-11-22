// The launcher: one press on Start agent / Resume task (a task's detail, or Home's
// latest-handoff card) / Work this goal opens the sheet in place — where the press happened —
// with the project and agent picks and the prompt the person reads before it is sent. Confirm
// sends exactly that prompt through the worker (`temper.launch.go`), which creates a new
// workspace with the agent in it (`workspace.create`) and stores the workspace ↔ item link in
// the plugin's own storage; nothing is written to temper on any press (design record,
// Rulings Q3): temper changes only when the agent acts. Consents gate by Q9's "Start, new
// workspace" row: the press needs `workspace:read`, `workspace:create` and `agent:launch`;
// a refused launch shows what Orca said, in the sheet.
//
// Decision ruling 23 splits Resume in two. Resume task is temper's resume — a fresh agent
// oriented to the latest handoff — so it is Start's act with the resume prompt, into a new
// workspace; when the item already has a linked workspace the sheet names it before the
// confirm, so a second worktree for the same work is never made unawares. The launcher never
// launches into an existing workspace (`agent.launch`): Orca's `agent.launch` drops its prompt
// today (stablyai/orca#41107). Reopen
// agent is Orca's resume — the same agent session, back in its workspace (`agent.resume`) —
// offered on a task only where a stored link carries a session, labelled with the workspace's
// name, with no temper prompt.
//
// Q5 is ruled (a) for now: the project is picked from `project.list` on each Start, and the
// rail remembers the last pick per context in local view state. The agent is picked from
// what Orca can launch on this host (`orca agent installed` — the host API has no
// enumeration). A task's prompt
// quotes the task's own newest linked session's Next section — the session→task `advances`
// edge — and says so when none exists; the person's newest session is never quoted in a
// task's place (Review 1). The Home card's Resume keeps the person's newest session: it is
// the card's own subject.
import {
  atom,
  Button,
  Callout,
  Card,
  CodeView,
  plugin,
  read,
  Row,
  Select,
  set,
  Stack,
  Text,
  type OrcaNode
} from 'orca'
import {
  ConsentNote,
  consentSentence,
  GatedAction,
  grantedCapabilities,
  missingConsents
} from './capabilities'
import {
  goalWorkPrompt,
  handoffResumePrompt,
  taskResumePrompt,
  taskStartPrompt,
  type PromptItem,
  type TaskHandoffInfo
} from './prompts'
import type {
  LaunchAgentsOutput,
  LaunchInput,
  LaunchItem,
  LaunchOutput,
  LaunchProjectsOutput,
  LinkedWorkspace,
  LinkedWorkspacesOutput,
  NextSummary,
  RecordDetail,
  ReopenOutput
} from './protocol'
import { LAUNCH_PRESS_NEEDS, REOPEN_NEEDS } from './protocol'
import { ensureSkillReadiness, SheetSkillNote } from './skill-readiness/region'

/** The act a sheet launches: the ruled buttons (Resume task stands on a task and on the
 *  handoff card, each with its own prompt). */
export type LaunchKind = 'task-start' | 'task-resume' | 'goal-work' | 'handoff-resume'

interface LaunchCompose {
  kind: LaunchKind
  /** Where the sheet renders: a pushed detail view, or Home beside the handoff card. */
  from: 'detail' | 'home'
  item: LaunchItem
  /** The handoff card's Next, quoted by its Resume prompt; null for the other acts. */
  handoffNext: NextSummary | null
}

/** What the sheet is composing; null while nothing was pressed. Held across the panel's runs,
 *  as the detail stack is — device-local view state (Rulings Q2) — so the rail reopens with
 *  the sheet where the person left it, and a check run can stand a sheet up from a seeded run.
 *  Its reads are not held: they are asked again when a carried sheet draws (`setupLauncher`). */
const launchCompose = atom<LaunchCompose | null>('launch-compose', null, { persist: 'plugin' })

/** The handoff behind the prompt; null while its read is out or it failed. For a task this is
 *  the task's own newest linked session (`temper.launch.task-handoff`) — never the person's
 *  latest session, which belongs to whatever work that session did (Review 1). */
const launchHandoff = atom<TaskHandoffInfo | null>('launch-handoff', null)

/** The picks the sheet stands over; null while the launch reads are still out. */
interface LaunchChoices {
  projects: LaunchProjectsOutput
  agents: LaunchAgentsOutput
}

const launchChoices = atom<LaunchChoices | null>('launch-choices', null)

/** The sheet's current picks. */
interface LaunchPick {
  projectId: string | null
  agent: string | null
}

const launchPick = atom<LaunchPick | null>('launch-pick', null)

/** Remembered project picks per home context — device-local view state (Rulings Q2/Q5 a). */
const lastProjectByContext = atom<Record<string, string>>(
  'last-project-by-context',
  {},
  { persist: 'plugin' }
)

/** Set while the launch request is out; the answer, once it lands — shown in the sheet, and
 *  held with the sheet it answers. */
const launchSending = atom('launch-sending', false)
const launchOutcome = atom<LaunchOutput | null>('launch-outcome', null, { persist: 'plugin' })

/** The words on each button and sheet heading, per act. */
const KIND_LABEL: Record<LaunchKind, string> = {
  'task-start': 'Start agent',
  'task-resume': 'Resume task',
  'goal-work': 'Work this goal',
  'handoff-resume': 'Resume task'
}

/**
 * The workspaces each item is linked to, as the worker names them (`temper.launch.links`);
 * null while the read is out. Read again each time an item's detail or sheet opens, and after
 * a launch lands — links change outside the panel (a workspace removed, a session learned).
 */
const itemLinks = atom<Record<string, LinkedWorkspacesOutput | null>>('item-links', {})

/** Asks the worker for one item's linked workspaces. A read that never answers is a failure. */
export async function loadItemLinks(itemId: string): Promise<void> {
  set(itemLinks, { ...read(itemLinks), [itemId]: read(itemLinks)[itemId] ?? null })
  let answer: LinkedWorkspacesOutput
  try {
    answer = await plugin.request('temper.launch.links', { itemId })
  } catch (error) {
    answer = {
      state: 'failed',
      message: `the linked-workspaces read never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(itemLinks, { ...read(itemLinks), [itemId]: answer })
}

/** One item's linked workspaces as last read; empty while out or failed. */
function linksOf(itemId: string): LinkedWorkspace[] {
  const answer = read(itemLinks)[itemId] ?? null
  return answer !== null && answer.state === 'ok' ? answer.links : []
}

/** A task's start and resume name the task's own latest linked session in their prompt;
 *  the handoff card's Resume names the person's latest session — its subject. */
function wantsHandoff(kind: LaunchKind): boolean {
  return kind === 'task-start' || kind === 'task-resume' || kind === 'handoff-resume'
}

/** The prompt as it stands now — re-rendered when the handoff read lands under it. */
function promptFor(compose: LaunchCompose): string {
  const item: PromptItem = compose.item
  const handoff = read(launchHandoff)
  switch (compose.kind) {
    case 'task-start':
      return taskStartPrompt(item, handoff)
    case 'task-resume':
      return taskResumePrompt(item, handoff)
    case 'goal-work':
      return goalWorkPrompt(item)
    case 'handoff-resume':
      return handoffResumePrompt(item, handoff?.next ?? null)
  }
}

/**
 * Opens the sheet for one press. The sheet draws at once; the launch reads (projects, agents,
 * the item's linked workspaces, the handoff when the prompt quotes one) resolve into their
 * atoms and re-render it.
 */
async function openLaunch(
  kind: LaunchKind,
  from: 'detail' | 'home',
  item: LaunchItem,
  handoffNext: NextSummary | null = null
): Promise<void> {
  const compose: LaunchCompose = { kind, from, item, handoffNext }
  set(launchCompose, compose)
  set(launchOutcome, null)
  await loadLaunch(compose)
}

/**
 * A sheet carried over from the panel's last run owes its reads, as a carried detail does:
 * it arrived without a press, so they are asked here. Its outcome stays as it was.
 */
export function setupLauncher(): void {
  const carried = read(launchCompose)
  if (carried !== null) {
    void loadLaunch(carried)
  }
}

/** The sheet's reads and its default picks, for the act it composes. */
async function loadLaunch(compose: LaunchCompose): Promise<void> {
  const { kind, item } = compose
  set(launchSending, false)
  set(launchChoices, null)
  set(
    launchHandoff,
    kind === 'handoff-resume' ? { hasSession: true, session: null, next: compose.handoffNext } : null
  )
  set(launchPick, { projectId: null, agent: null })
  // The picked agent's skill line reads Home's readiness answer, asked here if Home never did.
  ensureSkillReadiness()

  const [projects, agents, , taskRead] = await Promise.all([
    plugin.request('temper.launch.projects').catch(
      (): LaunchProjectsOutput => ({
        state: 'failed',
        message: 'the projects request never answered'
      })
    ),
    plugin.request('temper.launch.agents').catch(
      (): LaunchAgentsOutput => ({
        state: 'failed',
        message: 'the agents request never answered'
      })
    ),
    loadItemLinks(item.id),
    // A task's prompt quotes the task's own newest linked session — the session→task
    // `advances` edge — never the person's latest (Review 1).
    kind === 'task-start' || kind === 'task-resume'
      ? plugin.request('temper.launch.task-handoff', { id: item.id }).catch(() => null)
      : Promise.resolve(null)
  ])

  set(launchChoices, { projects, agents })

  if (taskRead !== null && (taskRead as { state?: string }).state === 'ok') {
    const handoff = (taskRead as { handoff: { id: string; ref: string; title: string; next: NextSummary | null } | null }).handoff
    set(launchHandoff, {
      hasSession: handoff !== null,
      session: handoff === null ? null : { id: handoff.id, ref: handoff.ref, title: handoff.title },
      next: handoff?.next ?? null
    })
  }

  const pick = read(launchPick)
  if (pick === null) {
    return
  }
  // The per-context memory lights the project pick when the context was started from before.
  const remembered = read(lastProjectByContext)[item.contextRef ?? '']
  const projectId =
    projects.state === 'ok' &&
    remembered !== undefined &&
    projects.projects.some((project) => project.id === remembered)
      ? remembered
      : null
  const agent =
    agents.state === 'ok'
      ? (agents.agents.find((choice) => choice.isDefault) ?? agents.agents[0])?.id ?? null
      : null
  set(launchPick, { projectId, agent })
}

/** Closes the sheet without sending. */
function cancelLaunch(): void {
  set(launchCompose, null)
  set(launchOutcome, null)
}

/**
 * The ruled first prompt, confirmed. The project pick is remembered per context the moment
 * the person confirms it (local view state); the launch itself is the worker's act, and the
 * answer — launched, refused, failed — lands in the sheet, with Orca's words for a refusal.
 */
async function confirmLaunch(): Promise<void> {
  const compose = read(launchCompose)
  const pick = read(launchPick)
  const choices = read(launchChoices)
  if (compose === null || pick === null || choices === null || pick.agent === null || pick.projectId === null) {
    return
  }
  set(lastProjectByContext, {
    ...read(lastProjectByContext),
    [compose.item.contextRef ?? '']: pick.projectId
  })
  // Always a new workspace (ruling 23): the only destination there is.
  const input: LaunchInput = {
    destination: 'new-workspace',
    projectId: pick.projectId,
    agent: pick.agent,
    prompt: promptFor(compose),
    item: compose.item
  }
  set(launchSending, true)
  try {
    const outcome = await plugin.request('temper.launch.go', input)
    set(launchOutcome, outcome)
    if (outcome.state === 'launched') {
      void loadItemLinks(compose.item.id)
    }
  } catch (error) {
    set(launchOutcome, {
      state: 'failed',
      message: `the launch request never answered: ${error instanceof Error ? error.message : String(error)}`
    })
  } finally {
    set(launchSending, false)
  }
}

/** The press button — gated on the consents a new-workspace launch needs.
 *  It is its view's one primary act: solid accent, its icon beside its label — until its
 *  sheet is open, when the sheet's confirm is the primary act and the press steps back to
 *  outline, so a view never holds two. */
function LaunchButton(props: {
  kind: LaunchKind
  from: 'detail' | 'home'
  item: LaunchItem
  handoffNext?: NextSummary | null
  named?: boolean
}) {
  const open = read(launchCompose)?.item.id === props.item.id
  return (
    <GatedAction
      needs={LAUNCH_PRESS_NEEDS}
      granted={read(grantedCapabilities)}
      label={KIND_LABEL[props.kind]}
      variant={open ? 'outline' : 'solid'}
      tone={open ? undefined : 'accent'}
      icon={props.kind === 'goal-work' ? 'rocket' : 'play'}
      named={props.named}
      onPress={() => void openLaunch(props.kind, props.from, props.item, props.handoffNext ?? null)}
    />
  )
}

/**
 * Which launcher act a detail gets: a backlog task Start agent, an in-progress one Resume
 * task, an active goal Work this goal (the ruled buttons); anything else none — a stage the
 * register does not name is not guessed into a launch.
 */
export function detailLaunchKind(detail: RecordDetail): LaunchKind | null {
  return detail.docType === 'task' && detail.stage === 'backlog'
    ? 'task-start'
    : detail.docType === 'task' && detail.stage === 'in-progress'
      ? 'task-resume'
      : detail.docType === 'goal' && detail.status === 'active'
        ? 'goal-work'
        : null
}

/** A detail view's launcher press, for the view's act row; its sheet is `LauncherSheet`, its
 *  missing consent `DetailLaunchConsent`, under the row. */
export function DetailLaunchButton(props: { detail: RecordDetail }): OrcaNode {
  const detail = props.detail
  const kind = detailLaunchKind(detail)
  if (kind === null) {
    return undefined
  }
  const item: LaunchItem = {
    id: detail.id,
    ref: detail.ref,
    title: detail.title,
    contextRef: detail.contextRef,
    docType: detail.docType
  }
  return <LaunchButton kind={kind} from="detail" item={item} named={false} />
}

/** The detail's launcher press, when its consent is missing: said under the act row. */
export function DetailLaunchConsent(props: { detail: RecordDetail }): OrcaNode {
  const kind = detailLaunchKind(props.detail)
  return kind === null ? undefined : (
    <ConsentNote act={KIND_LABEL[kind]} needs={LAUNCH_PRESS_NEEDS} granted={read(grantedCapabilities)} />
  )
}

/** The latest-handoff card's Resume task (Home) — a session start from that session. Its sheet is
 *  `LauncherSheet from="home"`, placed by Home after the card's omission sentence. */
export function HandoffLaunchButton(props: {
  handoff: {
    id: string
    ref: string
    title: string
    contextRef: string | null
    next: NextSummary | null
  }
}): OrcaNode {
  const item: LaunchItem = {
    id: props.handoff.id,
    ref: props.handoff.ref,
    title: props.handoff.title,
    contextRef: props.handoff.contextRef,
    docType: 'session'
  }
  return (
    <LaunchButton
      kind="handoff-resume"
      from="home"
      item={item}
      handoffNext={props.handoff.next}
    />
  )
}

/** The words under a sheet's description, per answer: Orca's own for a refusal. */
function OutcomeCallout(props: { outcome: LaunchOutput }): OrcaNode {
  const outcome = props.outcome
  if (outcome.state === 'launched') {
    return undefined
  }
  return outcome.state === 'refused' ? (
    <Callout tone="danger" title="Orca refused">
      <Text size="sm">
        {`${outcome.message}${outcome.code === null ? '' : ` (${outcome.code})`}`}
      </Text>
    </Callout>
  ) : (
    <Callout tone="warning" title="The launch never ran">
      <Text size="sm">{outcome.message}</Text>
    </Callout>
  )
}

/** A launch read that failed inside the sheet: what was not read, in the region's house words. */
function SheetReadFailure(props: { label: string; message: string }) {
  return (
    <Callout tone="warning" title={`${props.label} unavailable — nothing here was read.`}>
      <Text muted size="xs">
        {props.message}
      </Text>
    </Callout>
  )
}

/**
 * The sheet itself, rendered where the pressed button lives — for the item that press named
 * (`itemId`), so a sheet opened on one record never stands on another; undefined while
 * nothing was pressed. It is a card titled with its act; the prompt wraps, so every line the
 * person confirms is readable; the confirm is the sheet's one solid accent act, Cancel ghost
 * beside it, and why the confirm is dark stands under that row.
 */
export function LauncherSheet(props: { from: 'detail' | 'home'; itemId: string }): OrcaNode {
  const compose = read(launchCompose)
  if (compose === null || compose.from !== props.from || compose.item.id !== props.itemId) {
    return undefined
  }
  const title = KIND_LABEL[compose.kind]
  const outcome = read(launchOutcome)
  if (outcome !== null && outcome.state === 'launched') {
    return (
      <Card title={title}>
        <Stack gap="sm">
          <Callout tone="success" title="The agent was launched." />
          {outcome.linkError === null ? undefined : (
            <Callout tone="warning" title="The workspace's link to the item was not stored">
              <Text muted size="xs">
                {outcome.linkError}
              </Text>
            </Callout>
          )}
          <Row>
            <Button variant="ghost" onPress={cancelLaunch}>
              Close
            </Button>
          </Row>
        </Stack>
      </Card>
    )
  }

  const pick = read(launchPick)
  const choices = read(launchChoices)
  const granted = read(grantedCapabilities)
  const current: LaunchPick = pick ?? { projectId: null, agent: null }
  const missing = missingConsents(LAUNCH_PRESS_NEEDS, granted)
  const linked = linksOf(compose.item.id)

  const projects = choices?.projects ?? null
  const agents = choices?.agents ?? null
  const projectOptions =
    projects !== null && projects.state === 'ok'
      ? projects.projects.map((project) => ({
          value: project.id,
          label: `${project.name} · ${project.path}`
        }))
      : []
  const agentOptions =
    agents !== null && agents.state === 'ok'
      ? agents.agents.map((agent) => ({ value: agent.id, label: agent.name }))
      : []

  // Not-ready is said plainly beside a disabled confirm; missing consent is named by the
  // gated action in Orca's own words — never attempted.
  const unready: string | null =
    choices === null
      ? 'Reading what Orca can launch…'
      : current.agent === null
        ? 'Pick an agent.'
        : current.projectId === null
          ? 'Pick a project.'
          : null

  const sending = read(launchSending)
  // Why the confirm is dark, said under the confirm row so Cancel stays aligned beside it:
  // sending, a missing consent in Orca's words (warning), or a pick still owed (muted).
  const reason: OrcaNode = sending ? (
    <Text muted size="xs">
      ◌ launching …
    </Text>
  ) : missing.length > 0 ? (
    <Text tone="warning" size="xs">
      {consentSentence(missing)}
    </Text>
  ) : unready !== null ? (
    <Text muted size="xs">
      {unready}
    </Text>
  ) : undefined
  const ready = !sending && missing.length === 0 && unready === null

  return (
    <Card
      title={title}
      description="The first prompt — sent when you confirm, written to nothing but the agent."
    >
      <Stack gap="sm">
        <CodeView code={promptFor(compose)} wrap maxHeight="sm" label="first prompt" />
        {wantsHandoff(compose.kind) && compose.kind !== 'handoff-resume' && choices === null ? (
          <Text muted size="xs">
            ◌ the task's own latest handoff rides along once it answers; with none linked, the
            prompt says the task has no handoff yet.
          </Text>
        ) : undefined}
        <Text muted size="xs">
          The agent works in a new workspace: a new branch and worktree in the picked project.
        </Text>
        {linked.length === 0 ? undefined : <LinkedWorkspaceNote links={linked} />}
        {projects === null ? (
          <Text muted size="xs">◌ Reading Orca's projects…</Text>
        ) : projects.state === 'failed' ? (
          <SheetReadFailure label="Orca's projects" message={projects.message} />
        ) : (
          <Select
            label="Project"
            placeholder="Choose a project"
            value={current.projectId ?? undefined}
            options={projectOptions}
            onChange={(value) => set(launchPick, { ...current, projectId: value })}
          />
        )}
        {agents === null ? (
          <Text muted size="xs">◌ Reading what Orca can launch…</Text>
        ) : agents.state === 'failed' ? (
          <SheetReadFailure label="Orca's agents" message={agents.message} />
        ) : (
          <Select
            label="Agent"
            placeholder="Choose an agent"
            value={current.agent ?? undefined}
            options={agentOptions}
            onChange={(value) => set(launchPick, { ...current, agent: value })}
          />
        )}
        {agents !== null && agents.state === 'ok' ? <SheetSkillNote agent={current.agent} /> : undefined}
        {outcome === null ? undefined : <OutcomeCallout outcome={outcome} />}
        <Stack gap="xs">
          <Row gap="sm" align="center">
            <Button
              variant="solid"
              tone="accent"
              icon={compose.kind === 'goal-work' ? 'rocket' : 'play'}
              disabled={!ready}
              onPress={ready ? confirmLaunch : undefined}
            >
              {title}
            </Button>
            <Button variant="ghost" onPress={cancelLaunch} disabled={sending}>
              Cancel
            </Button>
          </Row>
          {reason}
        </Stack>
      </Stack>
    </Card>
  )
}

/**
 * The item's linked workspaces, named in the sheet before the confirm: a second worktree for
 * the same work is never made unawares (decision ruling 23). The confirm still makes a new
 * one; Reopen agent, on the task's detail, is the way back into a linked one.
 */
function LinkedWorkspaceNote(props: { links: readonly LinkedWorkspace[] }): OrcaNode {
  const names = props.links.map((link) => link.name)
  const title =
    names.length === 1
      ? `Already linked to the workspace ${names[0]}`
      : `Already linked to ${names.length} workspaces: ${names.join(', ')}`
  return (
    <Callout tone="neutral" icon="link" title={title}>
      <Text size="sm">
        Confirming makes another workspace for the same work; this one stays as it is.
      </Text>
    </Callout>
  )
}

/** The last Reopen agent answer, for the item and workspace it was pressed on. */
interface ReopenAnswer {
  itemId: string
  workspaceId: string
  name: string
  output: ReopenOutput | null
}

const reopenAnswer = atom<ReopenAnswer | null>('reopen-answer', null)

/** Reopen agent: the stored session, back in its workspace. The worker reads the session
 *  from its own stored link; the panel names only the item and the workspace. */
async function reopen(itemId: string, link: LinkedWorkspace): Promise<void> {
  const pending: ReopenAnswer = { itemId, workspaceId: link.workspaceId, name: link.name, output: null }
  set(reopenAnswer, pending)
  let output: ReopenOutput
  try {
    output = await plugin.request('temper.reopen.go', { itemId, workspaceId: link.workspaceId })
  } catch (error) {
    output = {
      state: 'failed',
      message: `the reopen request never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(reopenAnswer, { ...pending, output })
}

/** The links on which Reopen agent is offered: those carrying a session (and its agent). */
function reopenable(itemId: string): LinkedWorkspace[] {
  return linksOf(itemId).filter((link) => link.sessionId !== null && link.agent !== null)
}

/**
 * Reopen agent on a task's detail, one per linked workspace whose link carries a session,
 * each labelled with the workspace's name — outlined beside the view's one solid act. Not on
 * other records, and not where no link carries a session (a link without one offers none).
 */
export function ReopenButtons(props: { detail: RecordDetail }): OrcaNode {
  if (props.detail.docType !== 'task') {
    return undefined
  }
  const links = reopenable(props.detail.id)
  if (links.length === 0) {
    return undefined
  }
  const granted = read(grantedCapabilities)
  return (
    <>
      {links.map((link) => (
        <GatedAction
          key={`reopen-${link.workspaceId}`}
          needs={REOPEN_NEEDS}
          granted={granted}
          label={`Reopen agent — ${link.name}`}
          variant="outline"
          icon="agent"
          named={false}
          onPress={() => void reopen(props.detail.id, link)}
        />
      ))}
    </>
  )
}

/** Reopen agent's missing consent, under the act row, when Reopen is offered at all. */
export function ReopenConsent(props: { detail: RecordDetail }): OrcaNode {
  if (props.detail.docType !== 'task' || reopenable(props.detail.id).length === 0) {
    return undefined
  }
  return <ConsentNote act="Reopen agent" needs={REOPEN_NEEDS} granted={read(grantedCapabilities)} />
}

/** What the last Reopen agent press answered, on the detail it was pressed on. */
export function ReopenOutcome(props: { itemId: string }): OrcaNode {
  const answer = read(reopenAnswer)
  if (answer === null || answer.itemId !== props.itemId) {
    return undefined
  }
  const output = answer.output
  if (output === null) {
    return (
      <Text muted size="xs">
        {`◌ reopening the agent in ${answer.name} …`}
      </Text>
    )
  }
  if (output.state === 'reopened') {
    return (
      <Callout
        tone="success"
        title={
          output.started
            ? `The agent session was reopened in ${answer.name}.`
            : `The agent session is already running in ${answer.name}.`
        }
      />
    )
  }
  return output.state === 'refused' ? (
    <Callout tone="danger" title="Orca refused">
      <Text size="sm">{`${output.message}${output.code === null ? '' : ` (${output.code})`}`}</Text>
    </Callout>
  ) : (
    <Callout tone="warning" title="The reopen never ran">
      <Text size="sm">{output.message}</Text>
    </Callout>
  )
}
