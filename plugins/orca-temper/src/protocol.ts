// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// The worker is the only surface that talks to temper; the panel requests, the worker answers
// on the person's borrowed grant or refuses. Home's reads are the ones temper-ui's home makes
// for the same person (design record, Rulings Q1/R2), each its own request so one region can
// fail or refuse beside the others:
//
//   temper.home.resume    — the one resource the person last changed
//   temper.home.handoff   — the person's newest session, its Next section quoted
//   temper.home.way-in    — one of the standing ways in (goals, in progress, sessions),
//                           grown by the panel's Show more bound
//   temper.home.places    — the contexts the person changed something in
//   temper.home.recent    — recently updated across everything the person can read
//   temper.capabilities   — the capability kinds the host has granted the plugin; the
//                           panel lights actions with them and names those it may not run
//   temper.resource.detail — one record's meta, read with no `sections` query (no body, no
//                           open-meta run); the detail view draws it and nothing of the body
//   temper.goal.tasks     — a goal's linked tasks (the asserted `advances` edges), at the
//                           panel's bound — labelled "linked tasks", never "all tasks"
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
        /** Null when the session carries no Next heading — nothing is invented in its place. */
        next: NextSummary | null
      } | null
    }
  | RegionFailure

/** `temper.home.way-in` grows one way in in place: the bound the panel asks for, up to its cap. */
export interface WayInInput {
  id: string
  bound: number
}

export type WayInOutput =
  | {
      state: 'ok'
      /** The way's own id, label and scope, from temper-design's WAYS_IN. */
      id: string
      label: string
      scope: string
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

declare module 'orca' {
  interface PluginRequests {
    /** The one resource the person last changed, or a signed-out refusal. */
    'temper.home.resume': { output: ResumeOutput }
    /** The person's newest session and its Next section, or a signed-out refusal. */
    'temper.home.handoff': { output: LatestHandoffOutput }
    /** One way in (goals, in progress, sessions) at the panel's bound, or a signed-out refusal. */
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
  }
}
