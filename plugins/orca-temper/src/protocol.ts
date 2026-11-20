// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// The worker is the only surface that talks to temper; the panel requests, the worker answers
// on the person's borrowed grant or refuses.
export {}

/** One active goal, as the panel shows it. */
export interface GoalSummary {
  id: string
  ref: string
  title: string
}

/**
 * `temper.goals.active` answers one of two ways, and nothing in between: the goals found on the
 * person's grant, or a refusal that carries no goal data — none partial, none cached.
 */
export type ActiveGoalsOutput =
  | { connected: true; contextRef: string; goals: GoalSummary[]; truncated: boolean }
  | { connected: false; contextRef: string; message: string }

declare module 'orca' {
  interface PluginRequests {
    /** The person's active goals in the configured temper context, or a signed-out refusal. */
    'temper.goals.active': { output: ActiveGoalsOutput }
  }
}
