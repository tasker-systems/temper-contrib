// Agent skill readiness, the worker's end. A readiness read runs `orca agent installed` for the
// agents this host can launch, then `temper skill check --target <t> --format json` once per
// install target those agents need, and reads each check for the agents its target reaches
// (./harnesses.ts). An agent no target reaches is unknown with its reason; a check that fails or
// did not look where its target installs is unknown too — never ready.
//
// The Install press is the only path to `temper skill install`: it runs once per press, for the
// one target pressed, and answers with the directory the CLI says it wrote. No check, refresh or
// launch installs anything (design record, Q4 added: the install writes into the home directory,
// outside Orca's consent).
import type { OrcaWorkerApi } from 'orca/worker'
import { readLaunchableAgents } from '../agents'
import { deps } from '../deps'
import {
  agentReach,
  readCheck,
  SKILL_TARGETS,
  targetWrites,
  type SkillTarget,
  type TargetReading
} from './harnesses'
import type {
  HarnessReadiness,
  SkillInstallInput,
  SkillInstallOutput,
  SkillReadinessOutput,
  TargetReadiness
} from './protocol'

/** One target's check, run and read; a CLI that cannot be run is that target's unknown. */
async function checkTarget(target: SkillTarget, home: string): Promise<TargetReading> {
  try {
    const result = await deps.run(['skill', 'check', '--target', target, '--format', 'json'], process.env)
    return readCheck(target, home, result)
  } catch (error) {
    return {
      state: 'unknown',
      detail: `the temper CLI could not be run: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export async function skillReadiness(): Promise<SkillReadinessOutput> {
  const agents = await readLaunchableAgents()
  if (agents.state !== 'ok') {
    return { state: 'failed', message: agents.message }
  }
  const home = deps.home()
  const reaches = agents.agents.map((agent) => ({ agent, reach: agentReach(agent.id) }))
  // Each target the person's agents need, checked once, in the CLI's own order.
  const needed = SKILL_TARGETS.filter((target) => reaches.some(({ reach }) => reach.target === target))
  const readings = new Map<SkillTarget, TargetReading>()
  await Promise.all(
    needed.map(async (target) => {
      readings.set(target, await checkTarget(target, home))
    })
  )
  const harnesses: HarnessReadiness[] = reaches.map(({ agent, reach }) => {
    if (reach.target === null) {
      return { agent: agent.id, name: agent.name, target: null, state: 'unknown', detail: reach.reason }
    }
    const reading = readings.get(reach.target) ?? { state: 'unknown' as const, detail: 'not checked' }
    return { agent: agent.id, name: agent.name, target: reach.target, ...reading }
  })
  const targets: TargetReadiness[] = needed.map((target) => ({
    target,
    ...(readings.get(target) ?? { state: 'unknown' as const, detail: 'not checked' }),
    writes: targetWrites(target, home)
  }))
  return { state: 'ok', harnesses, targets }
}

export async function skillInstall(input: SkillInstallInput): Promise<SkillInstallOutput> {
  const target = input?.target
  if (!SKILL_TARGETS.includes(target)) {
    return { state: 'failed', target: null, message: `unknown install target: ${String(target)}` }
  }
  let result
  try {
    result = await deps.run(['skill', 'install', '--target', target, '--format', 'json'], process.env)
  } catch (error) {
    return {
      state: 'failed',
      target,
      message: `the temper CLI could not be run: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (result.code !== 0) {
    const words = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? ''
    return { state: 'failed', target, message: `temper skill install failed: ${words || `exit ${result.code}`}` }
  }
  try {
    const report = JSON.parse(result.stdout) as Record<string, unknown>
    if (typeof report['skill_dir'] !== 'string') {
      return { state: 'failed', target, message: 'temper skill install answered without the directory it wrote' }
    }
    return {
      state: 'installed',
      target,
      skillDir: report['skill_dir'],
      total: typeof report['total'] === 'number' ? report['total'] : 0,
      changed: Array.isArray(report['changed']) ? report['changed'].length : 0
    }
  } catch {
    return { state: 'failed', target, message: 'temper skill install answered something other than JSON' }
  }
}

export function registerSkillReadiness(orca: OrcaWorkerApi): void {
  orca.panels.handle('temper.skill.readiness', async (): Promise<SkillReadinessOutput> => skillReadiness())
  orca.panels.handle(
    'temper.skill.install',
    async (input: SkillInstallInput): Promise<SkillInstallOutput> => skillInstall(input)
  )
}
