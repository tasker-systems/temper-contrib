// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// The worker is the only surface that talks to temper; the panel requests, the worker answers
// on the person's borrowed grant or refuses. Home's reads are the ones temper-ui's home makes
// for the same person (design record, Rulings Q1/R2), each its own request so one region can
// fail or refuse beside the others:
//
//   temper.home.resume    — the one resource the person last changed
//   temper.home.handoff   — the person's newest session, its Next section quoted
//   temper.home.way-in    — one of the standing ways in (goals, tasks, sessions), grown by
//                           the panel's Show more bound, goals and tasks by a picked status
//   temper.home.places    — the contexts the person changed something in
//   temper.home.recent    — recently updated across everything the person can read
//   temper.capabilities   — the capability kinds the host has granted the plugin; the
//                           panel lights actions with them and names those it may not run
//   temper.resource.detail — one record's meta, read with no `sections` query (no body, no
//                           open-meta run); the detail view draws it and nothing of the body
//   temper.goal.tasks     — a goal's linked tasks (the asserted `advances` edges), at the
//                           panel's bound — labelled "linked tasks", never "all tasks"
//   temper.launch.projects — the projects Orca lists, for the launcher's project pick
//   temper.launch.agents   — the agents Orca can launch on this host (`orca agent installed`)
//   temper.launch.task-handoff — the task's own newest linked session and its Next section —
//                           never the person's latest (Review 1); feeds the task prompts
//   temper.launch.go      — the launch itself: workspace.create with the prompt the person
//                           saw; stores the workspace ↔ item link in the
//                           plugin's own storage on success. No temper write happens here
//                           (Rulings Q3): temper changes only when the agent acts.
//   temper.launch.links   — the workspaces an item is linked to, named as Orca lists them,
//                           each with the agent session the link carries (or none)
//   temper.reopen.go      — Reopen agent: `agent.resume` with the session a stored link
//                           carries, back in its workspace; no temper prompt, no temper write
//
// Every answer is one region's state: `ok` carries the read; `not-connected` is the signed-out
// refusal (never partial or cached data); `failed` names what failed. A `not-connected` region
// never draws — the refusal over the whole panel carries it.
export {}

/** One region's state, the failure shapes shared by every Home read. */
export type RegionFailure =
  /** The grant was never minted or temper refused it: no data answers, not even cached. */
  | { state: 'not-connected'; message: string }
  /** The read ran and failed; the region names what failed and shows nothing in its place. */
  | { state: 'failed'; message: string }

/** One temper resource, as Home's rows show it: ids and titles, its type word and home. */
export interface ResourceSummary {
  id: string
  ref: string
  title: string
  /** The doc-type word — it stands where an icon would. */
  docType: string
  /** The home-context address; null for a cogmap-homed resource. */
  contextRef: string | null
  updated: string
  /** The row's state in temper's word: a task's stage, else a goal's status; null for neither. */
  stage: string | null
}

/** `temper.home.resume`: the one resource the person last changed, by their own change time. */
export type ResumeOutput =
  | {
      state: 'ok'
      resume: {
        resource: ResourceSummary
        /** The person's own latest change — never `updated`, which a teammate's write moves. */
        changedAt: string
      } | null
    }
  | RegionFailure

/** The session's Next section, quoted as written (temper-design's `nextSection`, its own bound). */
export interface NextSummary {
  heading: string
  text: string
  truncated: boolean
}

/** `temper.home.handoff`: the person's newest session and its Next section, or the none of one. */
export type LatestHandoffOutput =
  | {
      state: 'ok'
      /** How many sessions of the person's the one-row page stands before. */
      sessionCount: number
      handoff: {
        id: string
        ref: string
        title: string
        /** The session's home-context address, for the resume prompt's naming. */
        contextRef: string | null
        /** Null when the session carries no Next heading — nothing is invented in its place. */
        next: NextSummary | null
      } | null
    }
  | RegionFailure

/** `temper.home.way-in` grows one way in in place: the bound the panel asks for, up to its cap. */
export interface WayInInput {
  id: string
  bound: number
  /**
   * The status a toggled way is read by (./way-status: a task stage, a goal status); absent
   * reads the way's WAYS_IN default. A way without toggles takes none.
   */
  status?: string
}

export type WayInOutput =
  | {
      state: 'ok'
      /** The way's own id, label and scope, from temper-design's WAYS_IN. */
      id: string
      label: string
      scope: string
      /** The status the rows were read by; null for a way without toggles. */
      status?: string | null
      rows: ResourceSummary[]
      total: number
      bound: number
    }
  | RegionFailure

/** One place the person works in: the context, and when they last changed something there. */
export interface PlaceInUse {
  ref: string
  name: string
  lastChangedAt: string
}

export type PlacesOutput =
  | { state: 'ok'; rows: PlaceInUse[]; total: number }
  | RegionFailure

export type RecentOutput =
  | { state: 'ok'; rows: ResourceSummary[]; total: number }
  | RegionFailure

/** `temper.capabilities` answers with the consent kinds the host has granted this plugin. */
export type CapabilitiesOutput = {
  granted: readonly string[]
}

/** One row of a record's meta, the key in temper's words, its value as the wire carries it. */
export interface PropertyRow {
  label: string
  value: string | number | boolean | null
}

/** The item's meta, one property in temper-ui's order, and nothing of the body. */
export interface RecordDetail {
  id: string
  ref: string
  title: string
  docType: string
  /** The managed stage (a task's workflow state), or null when the record carries none. */
  stage: string | null
  /** The managed status (a goal's workflow state), or null when the record carries none. */
  status: string | null
  /** The home-context address; null for a cogmap-homed record. */
  contextRef: string | null
  /**
   * In temper-ui's order (packages/temper-ui/src/lib/properties.ts): `doc_type` first, then the
   * managed run — ranked keys lead, unranked follow alphabetically. The open run is not shown:
   * without a `sections` query the read does not ask for it. Context, owner and updated close
   * the run; a cogmap-homed record carries no context row, and none is invented.
   */
  properties: PropertyRow[]
}

/** `temper.resource.detail`: one record's meta (the read asks no body, no sections). */
export interface RecordDetailInput {
  id: string
}

export type RecordDetailOutput =
  | { state: 'ok'; detail: RecordDetail }
  | RegionFailure

/** `temper.goal.tasks`: a goal's linked tasks — the `advances` edges, not every task. */
export interface LinkedTasksInput {
  /** The goal's id, a bare UUID. */
  id: string
  /** The explicit limit the read asks for; the raw list endpoint is uncapped without one. */
  bound: number
}

/** How many linked tasks a goal's detail shows before asking again — the ways-in bound. */
export const LINKED_TASKS_BOUND = 8

export type LinkedTasksOutput =
  | { state: 'ok'; rows: ResourceSummary[]; total: number; bound: number }
  | RegionFailure

/**
 * `temper.launch.projects`: Orca's projects (worker `project.list`), hidden ones left out —
 * the launcher's pick list. No temper read rides it: launching needs no temper grant (Q3).
 */
export interface LaunchProject {
  id: string
  name: string
  path: string
  hostId: string | null
}

export type LaunchProjectsOutput =
  | { state: 'ok'; projects: LaunchProject[] }
  | { state: 'failed'; message: string }

/** One agent Orca can launch on this host, as `orca agent installed --json` reports it. */
export interface LaunchAgentChoice {
  id: string
  name: string
  isDefault: boolean
}

export type LaunchAgentsOutput =
  | { state: 'ok'; agents: LaunchAgentChoice[] }
  | { state: 'failed'; message: string }

/** The item a launch serves; the link stored on a successful launch names the same. */
export interface LaunchItem {
  /** The temper record's bare UUID. */
  id: string
  ref: string
  title: string
  contextRef: string | null
}

/**
 * Where a launch lands the agent: a new workspace in a picked project (`workspace.create`).
 * It is the only destination — the launcher's (decision ruling 23) and the editor room's
 * "Hand to an agent" (ruling 25), which picks the view workspace's project. Orca's
 * `agent.launch` drops its prompt today (stablyai/orca#41107), so no launch goes through it.
 */
export type LaunchDestination = 'new-workspace'

/** `temper.launch.go`: one launch, the prompt exactly as the person saw it. */
export interface LaunchInput {
  destination: LaunchDestination
  /** The project the new workspace is made in: the launcher's pick, or the view's project. */
  projectId: string
  agent: string
  prompt: string
  item: LaunchItem
}

export type LaunchOutput =
  | {
      state: 'launched'
      /** The workspace the agent now runs in, as `workspace.create` made it. */
      workspaceId: string
      /** Its name as `workspace.list` gives it; null or absent when Orca did not list it after the create. */
      workspaceName?: string | null
      terminalId: string | null
      /** Set when the launch landed but the link could not be stored (e.g. no storage:own). */
      linkError: string | null
    }
  /** The caller's input was wrong before any Orca call; the panel's error, not a refusal. */
  | { state: 'failed'; message: string }
  /** Orca refused the launch; the message is what Orca said, its code when it carried one. */
  | { state: 'refused'; code: string | null; message: string }

/**
 * The workspace ↔ item link, stored in the plugin's own storage on a successful launch
 * (Rulings Q3 — the write-back stays local, never temper); item 7's launch hook reads it.
 * One entry per workspace × item; a relaunch of the same pair replaces its entry. A link
 * whose workspace is removed is dropped.
 */
export interface LaunchLink {
  /** The id the launch answered — `workspace.create`'s is the id `workspace.list` gives. */
  workspaceId: string
  itemId: string
  ref: string
  contextRef: string | null
  startedAt: string
  /** The agent the launch started; absent on a link that names none (no Reopen offered). */
  agent?: string
  /** The terminal `workspace.create` started the agent in — how its session is recognised. */
  terminalId?: string | null
  /**
   * The agent session running in that terminal, as Orca reported it (`agent.status.changed`
   * or `agents.list`, matched by the terminal) — never guessed. `agent.resume` takes it.
   * Absent until Orca names it; a link without one offers no Reopen.
   */
  sessionId?: string | null
}

/** The plugin-storage key under which the launch links sit, as a JSON array. */
export const LAUNCH_LINKS_KEY = 'launch-links'

/** One workspace an item is linked to, as the sheet and Reopen agent name it. */
export interface LinkedWorkspace {
  workspaceId: string
  /** The workspace's name as `workspace.list` gives it. */
  name: string
  agent: string | null
  /** The session a Reopen resumes; null when the link carries none (no Reopen offered). */
  sessionId: string | null
}

/** `temper.launch.links`: the workspaces one item is linked to. */
export interface LinkedWorkspacesInput {
  /** The item's bare UUID. */
  itemId: string
}

export type LinkedWorkspacesOutput =
  | { state: 'ok'; links: LinkedWorkspace[] }
  | { state: 'failed'; message: string }

/** `temper.reopen.go`: Reopen agent on one stored link — the worker reads the session itself. */
export interface ReopenInput {
  itemId: string
  workspaceId: string
}

export type ReopenOutput =
  | {
      state: 'reopened'
      terminalId: string
      /** False when an Orca terminal already runs the session: Orca started nothing new. */
      started: boolean
    }
  | { state: 'failed'; message: string }
  | { state: 'refused'; code: string | null; message: string }
/**
 * `temper.launch.task-handoff`: the task's own newest linked session and its Next section —
 * the session→task `advances` edge. null says the task has no handoff yet; it never falls
 * back to the person's latest, which belongs to whatever work that session did.
 */
export interface TaskHandoffInput {
  /** The task's id, a bare UUID. */
  id: string
}

export type TaskHandoffOutput =
  | {
      state: 'ok'
      handoff: { id: string; ref: string; title: string; next: NextSummary | null } | null
    }
  | RegionFailure

/**
 * What the launcher's press needs (Rulings Q9's "Start, new workspace" row): every launch goes
 * into a new workspace through `workspace.create`.
 */
export const LAUNCH_PRESS_NEEDS = ['workspace:read', 'workspace:create', 'agent:launch'] as const

/**
 * What Reopen agent needs: the stored link (`storage:own`), the workspace's name
 * (`workspace:read`), and `agent.resume` (`agent:launch`). Learning the session id takes
 * `agent:read`, but a link that already carries one reopens without it.
 */
export const REOPEN_NEEDS = ['workspace:read', 'agent:launch', 'storage:own'] as const

declare module 'orca' {
  interface PluginRequests {
    /** The one resource the person last changed, or a signed-out refusal. */
    'temper.home.resume': { output: ResumeOutput }
    /** The person's newest session and its Next section, or a signed-out refusal. */
    'temper.home.handoff': { output: LatestHandoffOutput }
    /** One way in (goals, tasks, sessions) at the panel's bound and status, or a signed-out refusal. */
    'temper.home.way-in': { input: WayInInput; output: WayInOutput }
    /** The contexts the person changed something in, by their own latest change in each. */
    'temper.home.places': { output: PlacesOutput }
    /** Recently updated across everything the person can read. */
    'temper.home.recent': { output: RecentOutput }
    /** The capability kinds Orca has granted the plugin; the panel lights actions with them. */
    'temper.capabilities': { output: CapabilitiesOutput }
    /** One record's meta, its read asking no body, no sections — or a signed-out refusal. */
    'temper.resource.detail': { input: RecordDetailInput; output: RecordDetailOutput }
    /** A goal's linked tasks at the panel's bound, or a signed-out refusal. */
    'temper.goal.tasks': { input: LinkedTasksInput; output: LinkedTasksOutput }
    /** The projects Orca lists, for the launcher's project pick — no temper grant rides it. */
    'temper.launch.projects': { output: LaunchProjectsOutput }
    /** The agents Orca can launch on this host. */
    'temper.launch.agents': { output: LaunchAgentsOutput }
    /** One launch: workspace.create, then the local link. */
    'temper.launch.go': { input: LaunchInput; output: LaunchOutput }
    /** The workspaces an item is linked to, named, each with its stored session or none. */
    'temper.launch.links': { input: LinkedWorkspacesInput; output: LinkedWorkspacesOutput }
    /** Reopen agent: agent.resume on the session a stored link carries; never a temper write. */
    'temper.reopen.go': { input: ReopenInput; output: ReopenOutput }
    /** The task's own newest linked session and its Next section — never the person's latest. */
    'temper.launch.task-handoff': { input: TaskHandoffInput; output: TaskHandoffOutput }
  }
}
