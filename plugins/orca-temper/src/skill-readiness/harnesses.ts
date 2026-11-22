// Which temper CLI skill install target reaches which agent Orca can launch, and what one
// `temper skill check --format json` report says about a target. Pure: no CLI, no host — the
// worker (./worker.ts) runs the commands and hands the answers here.
//
// The map is the Orca rail spike's agent-reach finding (§6, measured against Orca 1.4.264):
// `--target agents` writes `~/.agents/skills/temper/`, which codex, gemini, cursor, copilot,
// opencode and kimi read; Claude Code reads `~/.claude/skills/` only, so it needs
// `--target claude`. Kiro and Antigravity keep their own skill homes no target writes, and the
// rest have no skills discovery the spike could find. An agent not in the map is unknown —
// readiness is never guessed.
//
// A check is read for the target it names, and only where it looked there: the CLI's check
// reads the one directory its `skill.output` setting names whatever `--target` says (the target
// picks only the command wrapper), while an install writes the target's own directory. So a
// report whose `skill_dir` is not the target's directory does not speak for that target, and
// its agents read unknown — with the directory the check did read named.

/** The install targets that reach an agent Orca launches (the CLI's `--target` also takes
 *  `opencode`, but opencode reads `~/.agents/skills/` and is reached through `agents`). */
export type SkillTarget = 'agents' | 'claude'

export const SKILL_TARGETS: readonly SkillTarget[] = ['agents', 'claude']

/** Where each target installs, under the home directory (the CLI's own per-target defaults). */
const TARGET_DIR: Record<SkillTarget, string> = {
  agents: '.agents/skills/temper',
  claude: '.claude/skills/temper'
}

/** The command wrapper each target also writes; `agents` writes none. */
const TARGET_WRAPPER: Record<SkillTarget, string | null> = {
  agents: null,
  claude: '.claude/commands/temper.md'
}

/** The directory a target's install writes, for the home directory given. */
export function targetDir(target: SkillTarget, home: string): string {
  return `${home.replace(/\/+$/, '')}/${TARGET_DIR[target]}`
}

/** Every path a target's install writes: its skill directory, then its wrapper if it has one. */
export function targetWrites(target: SkillTarget, home: string): string[] {
  const wrapper = TARGET_WRAPPER[target]
  const base = home.replace(/\/+$/, '')
  return wrapper === null ? [targetDir(target, home)] : [targetDir(target, home), `${base}/${wrapper}`]
}

/** An agent Orca can launch: reached by a target, or unknown with the reason. */
export type AgentReach = { target: SkillTarget } | { target: null; reason: string }

/** Agents a target reaches (spike §6). */
const REACHED: Readonly<Record<string, SkillTarget>> = {
  claude: 'claude',
  // Orca's Claude Agent Teams launches the same Claude Code binary, which reads ~/.claude/skills.
  'claude-agent-teams': 'claude',
  codex: 'agents',
  gemini: 'agents',
  cursor: 'agents',
  copilot: 'agents',
  opencode: 'agents',
  kimi: 'agents'
}

/** Agents with a skill home of their own that no temper target writes (spike §6). */
const OWN_HOME: Readonly<Record<string, string>> = {
  kiro: '~/.kiro/skills',
  antigravity: '~/.gemini/config/skills'
}

/** Which target reaches one Orca agent id, or why none is known to. */
export function agentReach(agentId: string): AgentReach {
  const target = REACHED[agentId]
  if (target !== undefined) {
    return { target }
  }
  const own = OWN_HOME[agentId]
  if (own !== undefined) {
    return { target: null, reason: `it reads its skills from ${own}, which no temper install target writes` }
  }
  return { target: null, reason: 'no skills discovery is known for it' }
}

/** What a harness's line says. */
export type SkillState = 'ready' | 'missing' | 'out-of-date' | 'unknown'

/** One target's reading: its state, and the words that say why. */
export interface TargetReading {
  state: SkillState
  detail: string
}

/** The fields of `temper skill check --format json` this reading uses. */
interface CheckReport {
  skill_dir: string
  skill_dir_found: boolean
  expected_files?: number
  missing_files?: string[]
  config_hash?: { status: string }
  command_wrapper?: { status: string; path?: string }
}

function isCheckReport(value: unknown): value is CheckReport {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const box = value as Record<string, unknown>
  return typeof box['skill_dir'] === 'string' && typeof box['skill_dir_found'] === 'boolean'
}

const same = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * One target's check, read: the CLI's exit code and stdout as it answered. Ready only when the
 * check looked in the target's own directory and found every file, its config hash current and
 * its wrapper (where the target has one) present; anything the check could not say is unknown.
 */
export function readCheck(
  target: SkillTarget,
  home: string,
  result: { code: number; stdout: string; stderr: string }
): TargetReading {
  if (result.code !== 0) {
    const words = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? ''
    return { state: 'unknown', detail: `temper skill check failed: ${words || `exit ${result.code}`}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { state: 'unknown', detail: 'temper skill check answered something other than JSON' }
  }
  if (!isCheckReport(parsed)) {
    return { state: 'unknown', detail: 'temper skill check answered without a skill directory' }
  }
  const dir = targetDir(target, home)
  if (!same(parsed.skill_dir, dir)) {
    return {
      state: 'unknown',
      detail: `temper skill check reads ${parsed.skill_dir} (its skill.output setting), not ${dir}`
    }
  }
  if (!parsed.skill_dir_found) {
    return { state: 'missing', detail: `nothing at ${dir}` }
  }
  const missing = parsed.missing_files ?? []
  if (missing.length > 0) {
    const of = typeof parsed.expected_files === 'number' ? ` of ${parsed.expected_files}` : ''
    return { state: 'missing', detail: `${missing.length}${of} skill files missing from ${dir}` }
  }
  const hash = parsed.config_hash?.status
  if (hash === 'stale') {
    return { state: 'out-of-date', detail: `${dir} was installed for an older temper config` }
  }
  if (parsed.command_wrapper?.status === 'missing') {
    return {
      state: 'out-of-date',
      detail: `the /temper command wrapper is missing${parsed.command_wrapper.path === undefined ? '' : ` at ${parsed.command_wrapper.path}`}`
    }
  }
  if (hash !== 'up_to_date') {
    return { state: 'unknown', detail: `${dir} carries no config hash to check against` }
  }
  return { state: 'ready', detail: dir }
}

/** The state in words, as a harness's line says it. */
export const STATE_WORD: Record<SkillState, string> = {
  ready: 'ready',
  missing: 'missing',
  'out-of-date': 'out of date',
  unknown: 'unknown'
}

/** Whether an Install press is offered for a target in this state. */
export function installable(state: SkillState): boolean {
  return state !== 'ready'
}
