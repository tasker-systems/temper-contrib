// Agent skill readiness, the panel's end: Home's "agent skill" region and the launcher sheet's
// line for the agent picked. The worker answers both from one read (`temper.skill.readiness`);
// the panel never runs a command itself.
//
// Home shows one line per agent Orca can launch — ready, missing, out of date or unknown, in
// words — and, for each install target an agent there is not ready on, an Install press with
// the paths it writes stated beside it before anything is pressed. Only that press installs
// (`temper.skill.install`); the region reads again once it answers. The sheet names a skill
// that is not ready for the agent picked, and never blocks the launch: the first prompt already
// tells an agent without the skill what to do.
import { atom, Button, Callout, Heading, List, ListItem, plugin, read, Row, set, Skeleton, Stack, Text, type IconName, type OrcaNode } from 'orca'
import { installable, STATE_WORD, type SkillState } from './harnesses'
import type { SkillInstallOutput, SkillReadinessOutput, SkillTarget, TargetReadiness } from './protocol'

const LABEL = 'agent skill'
const SCOPE = 'the temper CLI skill, for each agent Orca can launch'

/** The readiness read's last answer; null while it is out (or before the first). */
const readiness = atom<SkillReadinessOutput | null>('skill-readiness', null)

/** Each target's last Install answer, held across the panel's runs as the launcher's outcome
 *  is (device-local view state), so the person sees where the install wrote after reopening. */
const installs = atom<Partial<Record<SkillTarget, SkillInstallOutput>>>('skill-installs', {}, { persist: 'plugin' })

/** The targets whose Install press is out, this run only — never carried across runs. */
const installing = atom<SkillTarget[]>('skill-installing', [])

/** Whether a readiness read was ever asked in this panel run. */
let asked = false

/** Reads readiness (again). Never installs. */
export async function loadSkillReadiness(): Promise<void> {
  asked = true
  set(readiness, null)
  let answer: SkillReadinessOutput
  try {
    answer = await plugin.request('temper.skill.readiness')
  } catch (error) {
    answer = {
      state: 'failed',
      message: `the skill readiness read never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(readiness, answer)
}

/** Reads readiness unless a read was already asked — the sheet's, so it never resets Home's. */
export function ensureSkillReadiness(): void {
  if (!asked) {
    void loadSkillReadiness()
  }
}

/** The Install press for one target: the only path to an install. */
async function install(target: SkillTarget): Promise<void> {
  set(installing, [...read(installing), target])
  let answer: SkillInstallOutput
  try {
    answer = await plugin.request('temper.skill.install', { target })
  } catch (error) {
    answer = {
      state: 'failed',
      target,
      message: `the install request never answered: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  set(installs, { ...read(installs), [target]: answer })
  set(installing, read(installing).filter((entry) => entry !== target))
  await loadSkillReadiness()
}

const STATE_ICON: Record<SkillState, IconName> = {
  ready: 'check',
  missing: 'warning',
  'out-of-date': 'warning',
  unknown: 'info'
}

/** The agents a target reaches, by name, as its Install press names them. */
function reachedNames(answer: SkillReadinessOutput & { state: 'ok' }, target: SkillTarget): string {
  return answer.harnesses
    .filter((harness) => harness.target === target)
    .map((harness) => harness.name)
    .join(', ')
}

/** An Install press's answer, under its press. */
function InstallAnswer(props: { target: SkillTarget }): OrcaNode {
  if (read(installing).includes(props.target)) {
    return (
      <Text muted size="xs">
        ◌ installing …
      </Text>
    )
  }
  const answer = read(installs)[props.target]
  if (answer === undefined) {
    return undefined
  }
  if (answer.state === 'installed') {
    return (
      <Callout tone="success" title={`Installed to ${answer.skillDir}`}>
        <Text muted size="xs">
          {answer.changed === 0
            ? `All ${answer.total} skill files were already current.`
            : `${answer.changed} of ${answer.total} skill files written.`}
        </Text>
      </Callout>
    )
  }
  return (
    <Callout tone="warning" title="The install did not complete">
      <Text muted size="xs">
        {answer.message}
      </Text>
    </Callout>
  )
}

/** One target's Install press, the paths it writes said beside it before any press. */
function InstallRow(props: { answer: SkillReadinessOutput & { state: 'ok' }; target: TargetReadiness }) {
  const pending = read(installing).includes(props.target.target)
  return (
    <Stack gap="xs">
      <Row gap="sm" align="center" wrap>
        <Button
          variant="outline"
          size="sm"
          icon="download"
          disabled={pending}
          onPress={() => void install(props.target.target)}
        >
          {`Install for ${reachedNames(props.answer, props.target.target)}`}
        </Button>
      </Row>
      <Text muted size="xs">{`Writes ${props.target.writes.join(' and ')} (temper skill install --target ${props.target.target}).`}</Text>
      <InstallAnswer target={props.target.target} />
    </Stack>
  )
}

/** Home's region: a line per agent, and Install where a target is not ready. */
export function SkillReadinessRegion(): OrcaNode {
  const answer = read(readiness)
  if (answer === null) {
    return (
      <Stack gap="sm">
        <Heading level={3}>{LABEL}</Heading>
        <Text muted size="xs">{`◌ Loading ${LABEL}…`}</Text>
        <Skeleton lines={2} label={`Loading ${LABEL}`} />
      </Stack>
    )
  }
  if (answer.state === 'failed') {
    return (
      <Stack gap="sm">
        <Heading level={3}>{LABEL}</Heading>
        <Callout tone="warning" title={`${LABEL} unavailable — nothing here was read.`}>
          <Text muted size="xs">
            {answer.message}
          </Text>
        </Callout>
      </Stack>
    )
  }
  return (
    <Stack gap="sm">
      <Heading level={3}>{LABEL}</Heading>
      <Text muted size="xs">
        {SCOPE}
      </Text>
      {answer.harnesses.length === 0 ? (
        <Text muted size="xs">— Orca names no agent it can launch.</Text>
      ) : (
        <List label={LABEL}>
          {answer.harnesses.map((harness) => (
            <ListItem
              key={harness.agent}
              title={harness.name}
              icon={STATE_ICON[harness.state]}
              description={`${STATE_WORD[harness.state]} · ${harness.detail}`}
            />
          ))}
        </List>
      )}
      {answer.targets.map((target) =>
        installable(target.state) ? (
          <InstallRow key={target.target} answer={answer} target={target} />
        ) : (
          // A target an install made ready keeps the install's answer under the lines.
          <InstallAnswer key={target.target} target={target.target} />
        )
      )}
    </Stack>
  )
}

/**
 * The launcher sheet's line for the agent picked: said when its skill is not ready, muted when
 * it is; it never disables the confirm.
 */
export function SheetSkillNote(props: { agent: string | null }): OrcaNode {
  const answer = read(readiness)
  if (props.agent === null) {
    return undefined
  }
  if (answer === null) {
    return (
      <Text muted size="xs">
        ◌ checking the agent's temper skill…
      </Text>
    )
  }
  if (answer.state === 'failed') {
    return <Text muted size="xs">{`Whether the agent has the temper skill was not read: ${answer.message}`}</Text>
  }
  const harness = answer.harnesses.find((entry) => entry.agent === props.agent)
  if (harness === undefined) {
    return <Text muted size="xs">Whether this agent has the temper skill is unknown — Orca did not list it.</Text>
  }
  if (harness.state === 'ready') {
    return <Text muted size="xs">{`${harness.name} has the temper skill.`}</Text>
  }
  if (harness.state === 'unknown') {
    return (
      <Text muted size="xs">{`Whether ${harness.name} has the temper skill is unknown: ${harness.detail}. The prompt tells it what to do without one.`}</Text>
    )
  }
  return (
    <Text tone="warning" size="xs">{`${harness.name}'s temper skill is ${STATE_WORD[harness.state]} (${harness.detail}). It can still start — Install on Home puts the skill in place.`}</Text>
  )
}
