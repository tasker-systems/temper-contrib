// The editor room's panel <-> worker contract, beside the rail's (`../protocol.ts`), merged into
// the same `PluginRequests` declaration:
//
//   temper.body.open — the detail's Open body: the worker reads the record with its body and
//                      body token, writes `.temper-views/<ref>.temper.md` in the focused
//                      workspace (kept out of git by an exclude entry in the common git dir),
//                      holds the base in plugin storage, and opens the file in an editor tab
//                      beside the person's view — never moving it.
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
  }
}
