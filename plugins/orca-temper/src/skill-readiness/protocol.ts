// Agent skill readiness's panel <-> worker contract, beside the rail's (`../protocol.ts`), merged
// into the same `PluginRequests` declaration:
//
//   temper.skill.readiness — one line per agent Orca can launch on this host
//                            (`orca agent installed`): the install target that reaches it and
//                            what `temper skill check --target <t> --format json` says there —
//                            ready, missing, out of date — or unknown, never guessed ready. Each
//                            target carries the paths its install writes, named before any press.
//   temper.skill.install   — the explicit Install press: `temper skill install --target <t>
//                            --format json`, and nothing else. Never run on a check, a launch or
//                            a refresh: the install writes into the home directory.
//
// Neither is a temper read (no grant gate) and neither needs a capability from Orca (Rulings Q9:
// "Skill check and install — none from Orca; an explicit press that names where it writes").
import type { SkillState, SkillTarget } from './harnesses'

export type { SkillState, SkillTarget } from './harnesses'

/** One agent Orca can launch, and whether its harness has the temper CLI skill. */
export interface HarnessReadiness {
  /** Orca's agent id (`claude`, `codex`, …). */
  agent: string
  /** The name Orca gives it. */
  name: string
  /** The install target that reaches it; null when none is known to. */
  target: SkillTarget | null
  state: SkillState
  /** Why, in words: the directory read, what is missing, or why it is unknown. */
  detail: string
}

/** One install target the person's agents need, as its check read it. */
export interface TargetReadiness {
  target: SkillTarget
  state: SkillState
  detail: string
  /** Every path `temper skill install --target <t>` writes, named before the press. */
  writes: string[]
}

export type SkillReadinessOutput =
  | { state: 'ok'; harnesses: HarnessReadiness[]; targets: TargetReadiness[] }
  | { state: 'failed'; message: string }

export interface SkillInstallInput {
  target: SkillTarget
}

export type SkillInstallOutput =
  | {
      state: 'installed'
      target: SkillTarget
      /** The directory the CLI says it wrote. */
      skillDir: string
      /** How many skill files the install carries, and how many it rewrote. */
      total: number
      changed: number
    }
  | { state: 'failed'; target: SkillTarget | null; message: string }

declare module 'orca' {
  interface PluginRequests {
    /** Per agent Orca can launch: the target reaching it, and its skill check's reading. */
    'temper.skill.readiness': { output: SkillReadinessOutput }
    /** The Install press: one `temper skill install --target <t>`; never run otherwise. */
    'temper.skill.install': { input: SkillInstallInput; output: SkillInstallOutput }
  }
}
