// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// The worker is the only surface that talks to temper; the panel requests, the worker answers
// on the person's borrowed grant or refuses. Each group answers one read:
//
//   temper.goals.active       — active goals in the goals contexts
//   temper.tasks.in-progress  — tasks whose stage is in-progress in the work contexts
//   temper.handoff.latest     — the most recently updated session note in the work contexts,
//                               with its Next steps section
//   temper.capabilities       — the capability kinds the host has granted the plugin; the
//                               panel lights actions with them and names those it may not run
//
// One summary carries how each group was asked: the context refs it read and, on the lists,
// an explicit limit and whether it truncated.
export {}

/** One temper resource, as every panel group shows it: ids and titles, nothing more. */
export interface ResourceSummary {
  id: string
  ref: string
  title: string
}

/**
 * `temper.goals.active` answers one of two ways, and nothing in between: the active goals found
 * on the person's grant across the goals contexts, or a refusal that carries no goal data —
 * none partial, none cached.
 */
export type ActiveGoalsOutput =
  | { connected: true; contexts: string[]; goals: ResourceSummary[]; truncated: boolean }
  | { connected: false; contexts: string[]; message: string }

/**
 * `temper.tasks.in-progress` answers one of two ways, and nothing in between: the in-progress
 * tasks found on the person's grant across the work contexts, or a refusal that carries no
 * task data — none partial, none cached.
 */
export type InProgressTasksOutput =
  | { connected: true; contexts: string[]; tasks: ResourceSummary[]; truncated: boolean }
  | { connected: false; contexts: string[]; message: string }

/** The latest handoff: one session note and its Next steps section — or the absence of one. */
export interface HandoffSummary {
  id: string
  ref: string
  title: string
  contextRef: string
  /** The note's Next steps section; null when the note carries none. */
  nextSteps: string | null
}

/**
 * `temper.handoff.latest` answers one of two ways, and nothing in between: the most recently
 * updated session note in the work contexts with its Next steps, or a refusal that carries no
 * note data. `truncated` reports older session notes the one-row page left out.
 */
export type LatestHandoffOutput =
  | { connected: true; contexts: string[]; truncated: boolean; handoff: HandoffSummary | null }
  | { connected: false; contexts: string[]; message: string }

/** `temper.capabilities` answers with the consent kinds the host has granted this plugin. */
export type CapabilitiesOutput = {
  granted: readonly string[]
}

declare module 'orca' {
  interface PluginRequests {
    /** The person's active goals in the goals contexts, or a signed-out refusal. */
    'temper.goals.active': { output: ActiveGoalsOutput }
    /** Tasks whose stage is in-progress in the work contexts, or a signed-out refusal. */
    'temper.tasks.in-progress': { output: InProgressTasksOutput }
    /** The latest session note's Next steps in the work contexts, or a signed-out refusal. */
    'temper.handoff.latest': { output: LatestHandoffOutput }
    /** The capability kinds Orca has granted the plugin; the panel lights actions with them. */
    'temper.capabilities': { output: CapabilitiesOutput }
  }
}
