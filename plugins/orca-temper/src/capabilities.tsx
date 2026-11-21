// Capability gating — the register's refusal face. The manifest declares the capabilities the
// next iterations will use (design record §Rulings, Q9) before their actions exist; the panel
// lights an action only when the person granted the consent it needs. An action whose consent
// is missing is drawn disabled and names the consent in Orca's own words — the panel refuses
// in its own words rather than letting Orca refuse the call later. The worker hands the panel
// the host's `grantedCapabilities` (a request away, below); the panel fills the one atom here,
// and every gated action reads it. An unanswered request leaves the atom empty, which lights
// nothing: the safe direction.
import { atom, Button, plugin, read, set, Stack, Text, type IconName, type Press, type Tone } from 'orca'

/** The host's consent kinds for this plugin, as the worker's `temper.capabilities` answers. */
export type GrantedCapabilities = readonly string[]

/**
 * Orca's own words for each capability kind — the descriptions Orca shows when it asks for the
 * consent, taken verbatim from `orca plugin dev load plugins/orca-temper --json` WITHOUT
 * `--approve` (its `approval_required` answer lists every declared capability with Orca's
 * description), on Orca 1.4.264 / host API 1.10. They are Orca's wording, not ours; when Orca
 * rewords them, re-run that load and copy the answers again. An unknown kind names itself.
 */
export const CONSENT_WORDS: Readonly<Record<string, string>> = {
  'settings:own': "Read and change the plugin's own settings",
  'workspace:read':
    'Read your projects and workspaces (names, branches, paths and agent status) and the terminals in them, and get notified when they change',
  'workspace:create':
    "Create workspaces (new Git branches and worktrees) in your projects, local and SSH; a project's setup script runs as its settings say",
  'agent:launch': 'Start and resume agents in your workspaces, local and SSH',
  'agent:read': 'Get notified when agent status changes',
  'storage:own': "Store data in the plugin's own storage folder",
  'workspace:write':
    'Open and rename your workspaces, hide projects from the sidebar or show them again, focus their terminals, open their files in Orca, and run its built-in commands'
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
 * needs; disabled with the missing consent named when not — in warning text, since the act
 * the person reached for is withheld. Every start, resume and
 * workspace-writing action the later iterations draw goes through here, so the panel can
 * never offer an act Orca would refuse.
 */
export function GatedAction(props: {
  needs: readonly string[]
  granted: readonly string[]
  label: string
  onPress?: Press
  variant?: 'solid' | 'outline' | 'ghost'
  /** Weight only: the label always carries the act. */
  tone?: Tone
  icon?: IconName
  /** False when the action stands in a row of acts: the row names the consent under itself
   *  (`ConsentNote`), so the buttons stay aligned. */
  named?: boolean
}) {
  const missing = missingConsents(props.needs, props.granted)
  if (missing.length === 0) {
    return (
      <Button onPress={props.onPress} variant={props.variant} tone={props.tone} icon={props.icon}>
        {props.label}
      </Button>
    )
  }
  if (props.named === false) {
    return (
      <Button disabled variant={props.variant} tone={props.tone} icon={props.icon}>
        {props.label}
      </Button>
    )
  }
  return (
    <Stack gap="xs">
      <Button disabled variant={props.variant} tone={props.tone} icon={props.icon}>
        {props.label}
      </Button>
      <Text tone="warning" size="xs">
        {consentSentence(missing)}
      </Text>
    </Stack>
  )
}

/**
 * A dark act's missing consent, said under the row it stands in and naming the act, since the
 * sentence is no longer beside its button: "Open body needs the '…' consent." Nothing when
 * every consent is granted.
 */
export function ConsentNote(props: { act: string; needs: readonly string[]; granted: readonly string[] }) {
  const missing = missingConsents(props.needs, props.granted)
  if (missing.length === 0) {
    return undefined
  }
  const sentence = consentSentence(missing)
  return (
    <Text tone="warning" size="xs">
      {`${props.act} n${sentence.slice(1)}`}
    </Text>
  )
}
