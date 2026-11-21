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
//   temper.body.local — asked by the custom editor: whether the view file on disk holds a local
//                      save its held base does not (a Cmd+S in Orca's editor, an agent's write).
//                      Reads the file only — never temper — so the view can say a local save
//                      did not reach temper.
//
//   temper.body.save  — the view's Save, the one act that writes a body to temper: the worker
//                      runs `temper resource update <id> --body @<file> --expect-body <held
//                      token>` as the person acting through the plugin's UI. No held token
//                      refuses before the CLI runs. A stale token writes nothing and answers
//                      the three versions (one read of temper's current).
//
//   temper.body.rebase — after a refused save, the current version becomes the held base; the
//                      person's text stays as the working text. With `discard`, the view file
//                      is rewritten to the current version too (the person's text is dropped).
//                      Neither writes to temper.
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

export interface LocalSaveInput {
  id: string
}

export type LocalSaveOutput =
  /** The file on disk says what the held base says, or was last written before it was read. */
  | { state: 'clean' }
  /** The file on disk holds a body the held base does not, saved locally after the base was read. */
  | { state: 'saved-locally'; savedAt: string }
  | { state: 'no-base'; message: string }
  /** The file could not be read; `message` says why. */
  | { state: 'unknown'; message: string }

export interface SaveInput {
  id: string
  /** The working text, exactly as the view holds it: frontmatter, then the body. */
  text: string
}

/** The three versions a refused save shows. */
export interface StaleVersions {
  /** The held base the person worked from. */
  base: string
  /** What the person (or an agent, on the person's view) wrote. */
  mine: string
  /** temper's body now — the other writer's version. */
  current: string
  /** When temper's current was read, ISO-8601 UTC. */
  currentReadAt: string
  /** When temper says the record last changed, when it says. */
  updatedAt: string | null
}

export type SaveOutput =
  | {
      /** The body is in temper; the held base is now the saved version. */
      state: 'saved'
      /** The new held base's read time — when the save was accepted. */
      readAt: string
      updatedAt: string | null
    }
  /** temper had moved past the base: nothing was written. */
  | ({ state: 'stale' } & StaleVersions)
  /** No body token is held, so no save was sent. */
  | { state: 'no-base'; message: string }
  /** Nothing was sent; `message` says why. */
  | { state: 'refused'; message: string }
  | RegionFailure

export interface RebaseInput {
  id: string
  /** Drop the person's text too: the view file is rewritten to the current version. */
  discard: boolean
}

export type RebaseOutput =
  | { state: 'rebased'; readAt: string; discarded: boolean }
  /** No refused save is held for this record, so there is no current version to move onto. */
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

/** temper's current version as a refused save read it, kept for carry-over and discard. */
export interface HeldCurrent {
  id: string
  body_token: string
  current: string
  read_at: string
}

export function heldCurrentKey(id: string): string {
  return `held-current:${id}`
}

declare module 'orca' {
  interface PluginRequests {
    /** Opens a record's body in an editor tab of the focused workspace, its base held. */
    'temper.body.open': { input: OpenBodyInput; output: OpenBodyOutput }
    /** Whether temper has moved past a record's held base; reads only. */
    'temper.body.base': { input: BaseCheckInput; output: BaseCheckOutput }
    /** Whether the view file holds a local save temper does not have; reads the file only. */
    'temper.body.local': { input: LocalSaveInput; output: LocalSaveOutput }
    /** The view's Save: one guarded body update, as the person acting through the plugin's UI. */
    'temper.body.save': { input: SaveInput; output: SaveOutput }
    /** After a refused save: the current version becomes the base; writes nothing to temper. */
    'temper.body.rebase': { input: RebaseInput; output: RebaseOutput }
  }
}
