// Capability gating — the register's refusal face. The manifest declares the capabilities the
// next iterations will use (design record §Rulings, Q9) before their actions exist; the panel
// lights an action only when the person granted the consent it needs. An action whose consent
// is missing is drawn disabled and names the consent in Orca's own words — the panel refuses
// in its own words rather than letting Orca refuse the call later. The worker hands the panel
// the host's `grantedCapabilities` (a request away, below); the panel fills the one atom here,
// and every gated action reads it. An unanswered request leaves the atom empty, which lights
// nothing: the safe direction.
import { atom, Button, plugin, read, set, Stack, Text, type Press } from 'orca'

/** The host's consent kinds for this plugin, as the worker's `temper.capabilities` answers. */
export type GrantedCapabilities = readonly string[]

/** Orca's own words for each consent kind; an unknown kind names itself. */
export const CONSENT_WORDS: Readonly<Record<string, string>> = {
  'settings:own': 'Edit plugin settings',
  'workspace:read': 'Read workspaces',
  'workspace:create': 'Create workspaces',
  'agent:launch': 'Launch agents',
  'agent:read': 'Read agents',
  'storage:own': 'Use plugin storage',
  'workspace:write': 'Write workspace files'
}

export function consentWord(kind: string): string {
  return CONSENT_WORDS[kind] ?? kind
}

/**
 * The disabled action's reason, in a sentence: "Needs the 'Create workspaces' consent." —
 * two or more consents read "… and 'Launch agents' consents."
 */
export function consentSentence(missing: readonly string[]): string {
  const names = missing.map((kind) => `'${consentWord(kind)}'`)
  if (names.length === 1) {
    return `Needs the ${names[0]} consent.`
  }
  const head = names.slice(0, -1).join(', ')
  return `Needs the ${head} and ${names[names.length - 1]} consents.`
}

/** The atom every gated action consults; filled from the worker's answer below. */
export const grantedCapabilities = atom<GrantedCapabilities>('granted-capabilities', [])

/**
 * Refreshes the granted consents from the worker. The shipped worker answers every panel, so a
 * rejection here means the panel outran its worker; the consents stay as last read, unlit.
 */
export async function refreshGrantedCapabilities(): Promise<void> {
  try {
    const answer = await plugin.request('temper.capabilities')
    set(grantedCapabilities, answer.granted)
  } catch {
    // Stay unlit rather than lit by a guess.
  }
}

/** Consents an action needs but the person has not granted, named in our words. */
export function missingConsents(
  needs: readonly string[],
  granted: readonly string[]
): string[] {
  return needs.filter((need) => !granted.includes(need))
}

/**
 * One action, lit only by granted consent: enabled when the panel holds every consent it
 * needs; disabled with the missing consent named when not. Every start, resume and
 * workspace-writing action the later iterations draw goes through here, so the panel can
 * never offer an act Orca would refuse.
 */
export function GatedAction(props: {
  needs: readonly string[]
  granted: readonly string[]
  label: string
  onPress?: Press
  variant?: 'solid' | 'outline' | 'ghost'
}) {
  const missing = missingConsents(props.needs, props.granted)
  if (missing.length === 0) {
    return (
      <Button onPress={props.onPress} variant={props.variant}>
        {props.label}
      </Button>
    )
  }
  return (
    <Stack gap="xs">
      <Button disabled variant={props.variant}>
        {props.label}
      </Button>
      <Text muted size="xs">
        {consentSentence(missing)}
      </Text>
    </Stack>
  )
}
