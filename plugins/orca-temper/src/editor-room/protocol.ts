// The editor room's panel <-> worker contract, beside the rail's (`../protocol.ts`), merged into
// the same `PluginRequests` declaration:
//
//   temper.body.open — the detail's Open body: the worker reads the record with its body and
//                      body token, writes `.temper-views/<ref>.temper.md` in the focused
//                      workspace (kept out of git by an exclude entry in the common git dir),
//                      holds the base in plugin storage, and opens the file in an editor tab
//                      beside the person's view — never moving it.
//
//   temper.body.base — asked by the custom editor: whether temper has moved past the held base.
//                      The worker reads the record's current `body_token` on the person's grant
//                      and compares it with the held one; it writes nothing. `current` and
//                      `behind` carry when the check ran; `no-base` says no base is held.
//
// `opened` names the file and the read time; `refused` says why nothing was written or opened,
// in words the panel shows as they come; `not-connected` and `failed` are the rail's own.
import type { RegionFailure } from '../protocol'

export interface OpenBodyInput {
  /** The record's id, a bare UUID. */
  id: string
}

export type OpenBodyOutput =
  | {
      state: 'opened'
      /** The view file, relative to the workspace. */
      path: string
      /** The workspace the tab opened in, by its name. */
      workspace: string
      /** When the held base was read, ISO-8601 UTC. */
      readAt: string
    }
  /** Nothing was written and nothing opened; `message` says why and, where one exists, the way out. */
  | { state: 'refused'; message: string }
  | RegionFailure

export interface BaseCheckInput {
  /** The record's id, a bare UUID. */
  id: string
}

export type BaseCheckOutput =
  | {
      /** temper's current body is the held base's: the view works from the current record. */
      state: 'current'
      /** When the held base was read, ISO-8601 UTC. */
      readAt: string
      /** When temper answered this check, ISO-8601 UTC. */
      checkedAt: string
    }
  | {
      /** temper's body has moved past the held base: the view is not the current record. */
      state: 'behind'
      readAt: string
      checkedAt: string
      /** When temper says the record last changed, when it says. */
      updatedAt: string | null
    }
  /** No base is held for this record, so there is nothing to compare; `message` says why. */
  | { state: 'no-base'; message: string }
  | RegionFailure

/** The held base, as plugin storage keeps it under `heldBaseKey(id)`. */
export interface HeldBase {
  id: string
  /** The token a later Save sends as `--expect-body`. */
  body_token: string
  /** The body exactly as read — the base the difference is taken against. */
  base: string
  read_at: string
  /** The view file's absolute path. */
  path: string
  workspaceId: string
}

export function heldBaseKey(id: string): string {
  return `held-base:${id}`
}

declare module 'orca' {
  interface PluginRequests {
    /** Opens a record's body in an editor tab of the focused workspace, its base held. */
    'temper.body.open': { input: OpenBodyInput; output: OpenBodyOutput }
    /** Whether temper has moved past a record's held base; reads only. */
    'temper.body.base': { input: BaseCheckInput; output: BaseCheckOutput }
  }
}
