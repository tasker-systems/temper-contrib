// The launcher: one press on Start agent / Resume agent / Resume (the handoff card) / Work
// this goal opens the sheet in place — where the press happened (a detail view, or Home's
// latest-handoff card) — with the destination, the project and agent picks, and the prompt
// the person reads before it is sent. Confirm sends exactly that prompt through the worker
// (`temper.launch.go`), which launches the agent and stores the workspace ↔ item link in the
// plugin's own storage; nothing is written to temper on any press (design record, Rulings
// Q3): temper changes only when the agent acts. Consents gate by Q9's table: the press needs
// `workspace:read` + `agent:launch`; "New workspace" names `workspace:create` when it lacks
// it; a refused launch shows what Orca said, in the sheet.
//
// Q5 is ruled (a) for now: the project is picked from `project.list` on each Start, and the
// rail remembers the last pick per context in local view state. Defaults: Start defaults to
// a new workspace; Resume defaults to this workspace when the task is already linked here
// (the launch links in plugin storage name it). The agent is picked from what Orca can launch
// on this host (`orca agent installed` — the host API has no enumeration). A task's prompt
// quotes the task's own newest linked session's Next section — the session→task `advances`
// edge — and says so when none exists; the person's newest session is never quoted in a
// task's place (Review 1). The Home card's Resume keeps the person's newest session: it is
// the card's own subject.
import {
  atom,
  Button,
  Code,
  Heading,
  host,
  plugin,
  RadioGroup,
  read,
  Row,
  Select,
  set,
  Stack,
  storage,
  Text,
  type OrcaNode
} from 'orca'
import {
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
  LaunchDestination,
  LaunchInput,
  LaunchItem,
  LaunchLink,
  LaunchOutput,
  LaunchProjectsOutput,
  NextSummary,
  RecordDetail
} from './protocol'
import {
  LAUNCH_LINKS_KEY,
  LAUNCH_NEW_WORKSPACE_NEEDS,
  LAUNCH_PRESS_NEEDS,
  LAUNCH_THIS_WORKSPACE_NEEDS
} from './protocol'

/** The act a sheet launches: the four ruled buttons. */
export type LaunchKind = 'task-start' | 'task-resume' | 'goal-work' | 'handoff-resume'

interface LaunchCompose {
  kind: LaunchKind
  /** Where the sheet renders: a pushed detail view, or Home beside the handoff card. */
  from: 'detail' | 'home'
  item: LaunchItem
}

/** What the sheet is composing; null while nothing was pressed. */
const launchCompose = atom<LaunchCompose | null>('launch-compose', null)

/** The handoff behind the prompt; null while its read is out or it failed. For a task this is
 *  the task's own newest linked session (`temper.launch.task-handoff`) — never the person's
 *  latest session, which belongs to whatever work that session did (Review 1). */
const launchHandoff = atom<TaskHandoffInfo | null>('launch-handoff', null)

/** The picks the sheet stands over; null while the launch reads are still out. */
interface LaunchChoices {
  projects: LaunchProjectsOutput
  agents: LaunchAgentsOutput
  /** The focused workspace, when Orca names one (and workspace:read lets us ask). */
  workspace: { id: string; name: string } | null
  /** True when the item is already linked to the focused workspace (the resume default). */
  linkedHere: boolean
}

const launchChoices = atom<LaunchChoices | null>('launch-choices', null)

/** The sheet's current picks. */
interface LaunchPick {
  destination: LaunchDestination
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

/** Set while the launch request is out; the answer, once it lands — shown in the sheet. */
const launchSending = atom('launch-sending', false)
const launchOutcome = atom<LaunchOutput | null>('launch-outcome', null)

/** The words on each button and sheet heading, per act. */
const KIND_LABEL: Record<LaunchKind, string> = {
  'task-start': 'Start agent',
  'task-resume': 'Resume agent',
  'goal-work': 'Work this goal',
  'handoff-resume': 'Resume'
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
 * the focused workspace, the stored links, the handoff when the prompt quotes one) resolve
 * into their atoms and re-render it. When the item is a task already linked to this
 * workspace, Resume defaults there (Q5); everything else defaults to a new workspace.
 */
async function openLaunch(
  kind: LaunchKind,
  from: 'detail' | 'home',
  item: LaunchItem,
  handoffNext: NextSummary | null = null
): Promise<void> {
  set(launchCompose, { kind, from, item })
  set(launchOutcome, null)
  set(launchSending, false)
  set(launchChoices, null)
  set(launchHandoff, kind === 'handoff-resume' ? { hasSession: true, session: null, next: handoffNext } : null)
  set(launchPick, {
    destination: 'new-workspace',
    projectId: null,
    agent: null
  })

  const orNull = (promise: Promise<unknown>): Promise<null | unknown> => promise.catch(() => null)
  const [projects, agents, workspace, links, taskRead] = await Promise.all([
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
    orNull(host.call('workspace.readContext')),
    orNull(storage.get(LAUNCH_LINKS_KEY)),
    // A task's prompt quotes the task's own newest linked session — the session→task
    // `advances` edge — never the person's latest (Review 1).
    kind === 'task-start' || kind === 'task-resume'
      ? plugin.request('temper.launch.task-handoff', { id: item.id }).catch(() => null)
      : Promise.resolve(null)
  ])

  const focused =
    workspace !== null &&
    typeof workspace === 'object' &&
    typeof (workspace as { workspaceId?: unknown }).workspaceId === 'string'
      ? {
          id: (workspace as { workspaceId: string }).workspaceId,
          name: (workspace as { displayName: string }).displayName
        }
      : null
  const linkRows = Array.isArray(links) ? (links as LaunchLink[]) : []
  const linkedHere =
    focused !== null &&
    linkRows.some((link) => link.itemId === item.id && link.workspaceId === focused.id)
  set(launchChoices, { projects, agents, workspace: focused, linkedHere })

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
  // Resume defaults to this workspace only when the task is already linked here (Q5).
  const destination: LaunchDestination =
    kind === 'task-resume' && linkedHere ? 'this-workspace' : 'new-workspace'
  set(launchPick, { destination, projectId, agent })
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
  if (compose === null || pick === null || choices === null || pick.agent === null) {
    return
  }
  if (pick.destination === 'new-workspace' && pick.projectId === null) {
    return
  }
  if (pick.destination === 'this-workspace' && choices.workspace === null) {
    return
  }
  if (pick.destination === 'new-workspace' && pick.projectId !== null) {
    set(lastProjectByContext, {
      ...read(lastProjectByContext),
      [compose.item.contextRef ?? '']: pick.projectId
    })
  }
  const input: LaunchInput = {
    destination: pick.destination,
    ...(pick.destination === 'new-workspace' ? { projectId: pick.projectId ?? undefined } : {}),
    ...(pick.destination === 'this-workspace'
      ? { workspaceId: choices.workspace?.id ?? undefined }
      : {}),
    agent: pick.agent,
    prompt: promptFor(compose),
    item: compose.item
  }
  set(launchSending, true)
  try {
    set(launchOutcome, await plugin.request('temper.launch.go', input))
  } catch (error) {
    set(launchOutcome, {
      state: 'failed',
      message: `the launch request never answered: ${error instanceof Error ? error.message : String(error)}`
    })
  } finally {
    set(launchSending, false)
  }
}

/** The press button — gated on the minimum consents; the sheet gates the destination further.
 *  It is its view's one primary act: solid accent, its icon beside its label. */
function LaunchButton(props: {
  kind: LaunchKind
  from: 'detail' | 'home'
  item: LaunchItem
  handoffNext?: NextSummary | null
}) {
  return (
    <GatedAction
      needs={LAUNCH_PRESS_NEEDS}
      granted={read(grantedCapabilities)}
      label={KIND_LABEL[props.kind]}
      variant="solid"
      tone="accent"
      icon={props.kind === 'goal-work' ? 'rocket' : 'play'}
      onPress={() => void openLaunch(props.kind, props.from, props.item, props.handoffNext ?? null)}
    />
  )
}

/**
 * Which launcher act a detail gets: a backlog task Start agent, an in-progress one Resume
 * agent, an active goal Work this goal (the ruled buttons); anything else none — a stage the
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

/** A detail view's launcher press, for the view's act row; its sheet is `LauncherSheet`. */
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
    contextRef: detail.contextRef
  }
  return <LaunchButton kind={kind} from="detail" item={item} />
}

/** The latest-handoff card's Resume (Home) — a session start from that session. Its sheet is
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
    contextRef: props.handoff.contextRef
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

/** The sheet itself, rendered where the pressed button lives; undefined while nothing was pressed. */
export function LauncherSheet(props: { from: 'detail' | 'home' }): OrcaNode {
  const compose = read(launchCompose)
  if (compose === null || compose.from !== props.from) {
    return undefined
  }
  const outcome = read(launchOutcome)
  if (outcome !== null && outcome.state === 'launched') {
    return (
      <Stack gap="xs">
        <Text tone="success">✓ the agent was launched.</Text>
        {outcome.linkError === null ? undefined : (
          <Text tone="warning" size="xs">
            {`⚠ the workspace's link to the item could not be stored: ${outcome.linkError}`}
          </Text>
        )}
        <Row>
          <Button variant="ghost" onPress={cancelLaunch}>
            Close
          </Button>
        </Row>
      </Stack>
    )
  }

  const pick = read(launchPick)
  const choices = read(launchChoices)
  const granted = read(grantedCapabilities)
  const destination: LaunchDestination = pick?.destination ?? 'new-workspace'
  const current: LaunchPick = pick ?? { destination, projectId: null, agent: null }
  const needs =
    destination === 'new-workspace' ? LAUNCH_NEW_WORKSPACE_NEEDS : LAUNCH_THIS_WORKSPACE_NEEDS
  const missing = missingConsents(needs, granted)
  const newWorkspaceBlocked = missingConsents(['workspace:create'], granted).length > 0

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
        : destination === 'new-workspace' && current.projectId === null
          ? 'Pick a project.'
          : destination === 'this-workspace' && choices.workspace === null
            ? 'No workspace is focused in Orca.'
            : null

  return (
    <Stack gap="sm">
      <Heading level={3}>
        {compose.kind === 'goal-work' ? 'Work this goal' : KIND_LABEL[compose.kind]}
      </Heading>
      <Text muted size="xs">
        The first prompt — sent when you confirm, written to nothing but the agent.
      </Text>
      <Code block>{promptFor(compose)}</Code>
      {wantsHandoff(compose.kind) && compose.kind !== 'handoff-resume' && read(launchChoices) === null ? (
        <Text muted size="xs">
          ◌ the task's own latest handoff rides along once it answers; with none linked, the
          prompt says the task has no handoff yet.
        </Text>
      ) : undefined}
      <RadioGroup
        label="Where the agent works"
        value={destination}
        onChange={(value) =>
          set(launchPick, {
            ...current,
            destination: value === 'this-workspace' ? 'this-workspace' : 'new-workspace'
          })
        }
        options={[
          {
            value: 'new-workspace',
            label: 'New workspace',
            disabled: newWorkspaceBlocked,
            description: newWorkspaceBlocked
              ? consentSentence(['workspace:create'])
              : 'a new branch and worktree in the picked project'
          },
          {
            value: 'this-workspace',
            label:
              choices?.workspace != null
                ? `This workspace — ${choices.workspace.name}`
                : 'This workspace',
            disabled: choices === null || choices.workspace === null,
            description:
              choices !== null && choices.workspace === null
                ? 'No workspace is focused in Orca.'
                : 'the agent launches in the workspace Orca has focused'
          }
        ]}
      />
      {destination !== 'new-workspace' ? undefined : projects === null ? (
        <Text muted size="xs">◌ Reading Orca's projects…</Text>
      ) : projects.state === 'failed' ? (
        <Text tone="warning" size="xs">{`⚠ ${projects.message}`}</Text>
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
        <Text tone="warning" size="xs">{`⚠ ${agents.message}`}</Text>
      ) : (
        <Select
          label="Agent"
          placeholder="Choose an agent"
          value={current.agent ?? undefined}
          options={agentOptions}
          onChange={(value) => set(launchPick, { ...current, agent: value })}
        />
      )}
      {outcome === null ? undefined : outcome.state === 'refused' ? (
        <Text tone="warning" size="xs">
          {`⚠ Orca refused: ${outcome.message}${outcome.code === null ? '' : ` (${outcome.code})`}`}
        </Text>
      ) : (
        <Text tone="warning" size="xs">{`⚠ the launch never ran: ${outcome.message}`}</Text>
      )}
      <Row gap="sm">
        {read(launchSending) ? (
          <Text muted size="xs">
            ◌ launching …
          </Text>
        ) : missing.length > 0 ? (
          <GatedAction needs={needs} granted={granted} label={KIND_LABEL[compose.kind]} />
        ) : unready !== null ? (
          <Stack gap="xs">
            <Button disabled>{KIND_LABEL[compose.kind]}</Button>
            <Text muted size="xs">
              {unready}
            </Text>
          </Stack>
        ) : (
          <GatedAction
            needs={needs}
            granted={granted}
            label={KIND_LABEL[compose.kind]}
            onPress={confirmLaunch}
          />
        )}
        <Button variant="ghost" onPress={cancelLaunch} disabled={read(launchSending)}>
          Cancel
        </Button>
      </Row>
    </Stack>
  )
}
