// The first prompts the launcher sends (design record, Rulings Q4 and Q4a): harness-agnostic
// text, never a `/command` — not every harness honours slash commands. Each names the temper
// skill and the `temper` CLI, the item's full ref and its home context, the bare-id read, and
// the no-skill fallback. A task start or resume also quotes the task's own latest linked
// session's Next section as written — the orientation the agent starts from — and says so
// when the task has no handoff yet; the person's latest session is never quoted in a task's
// place (Review 1; the Home handoff card's Resume is the exception, that session being its
// subject). The person sees the assembled prompt in the launcher sheet before it is sent,
// and the press writes nothing to temper (Rulings Q3): temper changes only when the agent acts.
import type { NextSummary } from './protocol'

/** The item a prompt names: its full ref, its home context, its bare id for the read. */
export interface PromptItem {
  id: string
  ref: string
  title: string
  /** The home-context address; a cogmap-homed record carries null and is said so. */
  contextRef: string | null
}

/** "…, in context `…`." — the ruled naming; a cogmap-homed record names its home honestly. */
function homeClause(item: PromptItem): string {
  return item.contextRef === null ? 'no home context (it is cogmap-homed)' : `context \`${item.contextRef}\``
}

const FALLBACK =
  'If you have no temper skill, run `temper skill check` and use `temper --help` as the syntax authority.'

/**
 * A task's own handoff state for a start/resume prompt: the task's newest linked session and
 * its Next section. `hasSession` false means no session has advanced the task — the prompt
 * says so and quotes nothing; it never quotes the person's latest instead (Review 1).
 */
export interface TaskHandoffInfo {
  hasSession: boolean
  session: { id: string; ref: string; title: string } | null
  next: NextSummary | null
}

/** The quoted Next section (Home's handoff card — the person's latest session is its subject). */
function handoffClause(next: NextSummary | null): string | null {
  if (next === null) {
    return null
  }
  return `The latest handoff names what is next — its Next section, as written:\n${next.text}`
}

/** The task's handoff, in the prompt: quoted as written, said as absent, never substituted.
 *  null overall means the read failed — the clause is left out, not claimed. */
function taskHandoffClause(handoff: TaskHandoffInfo | null): string | null {
  if (handoff === null) {
    return null
  }
  if (!handoff.hasSession) {
    return 'The task has no handoff yet — no session has advanced it.'
  }
  if (handoff.next === null) {
    return `The task's latest session (ref \`${handoff.session?.ref ?? ''}\`) carries no Next section; read it with \`temper resource show ${handoff.session?.id ?? ''} --format json\` for where it stood.`
  }
  return `The task's latest handoff names what is next — its Next section, as written:\n${handoff.next.text}`
}

/** Q4's draft for task start, its fields filled, the task's own handoff after it. */
export function taskStartPrompt(item: PromptItem, handoff: TaskHandoffInfo | null): string {
  return [
    'You are starting work on a temper task. Use the temper skill with the `temper` CLI if you have it.',
    `Start the task: ref \`${item.ref}\`, in ${homeClause(item)}. Read it with \`temper resource show ${item.id} --format json\`, follow its instructions (including any "How to hold this item" section), and set it in-progress through the skill's task-start flow.`,
    FALLBACK,
    taskHandoffClause(handoff)
  ]
    .filter((part) => part !== null)
    .join('\n')
}

/** The same pattern for resuming an in-progress task. */
export function taskResumePrompt(item: PromptItem, handoff: TaskHandoffInfo | null): string {
  return [
    'You are resuming work on a temper task. Use the temper skill with the `temper` CLI if you have it.',
    `Resume the task: ref \`${item.ref}\`, in ${homeClause(item)}. Read it with \`temper resource show ${item.id} --format json\`, follow its instructions (including any "How to hold this item" section), and continue it through the skill's task-resume flow, from its latest session.`,
    FALLBACK,
    taskHandoffClause(handoff)
  ]
    .filter((part) => part !== null)
    .join('\n')
}

/** Session start from the latest handoff card on Home. */
export function handoffResumePrompt(item: PromptItem, next: NextSummary | null): string {
  return [
    "You are starting a session from the person's latest temper handoff. Use the temper skill with the `temper` CLI if you have it.",
    `The handoff: session ref \`${item.ref}\`, in ${homeClause(item)}. Read it with \`temper resource show ${item.id} --format json\` and start from its Next section, through the skill's session-start flow if one is named.`,
    FALLBACK,
    handoffClause(next)
  ]
    .filter((part) => part !== null)
    .join('\n')
}

/** Q4a's ruled wording for an active goal, verbatim but with the refs filled. */
export function goalWorkPrompt(item: PromptItem): string {
  return `You are taking up a temper goal. Use the temper skill with the \`temper\` CLI if you have it, following its working-a-goal guidance. Goal: ref \`${item.ref}\`, context \`${item.contextRef ?? 'none — it is cogmap-homed'}\`. Read what is in force (the register, its current witnessed state, recent sessions and linked tasks), then propose the next chunk of work and the clause it advances. File nothing until the person agrees.`
}
