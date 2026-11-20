// The first prompts the launcher sends (design record, Rulings Q4 and Q4a): harness-agnostic
// text, never a `/command` — not every harness honours slash commands. Each names the temper
// skill and the `temper` CLI, the item's full ref and its home context, the bare-id read, and
// the no-skill fallback. A task start or resume also quotes the latest handoff's Next section
// as written — the orientation the agent starts from — when one was read; nothing is invented
// in its place. The person sees the assembled prompt in the launcher sheet before it is sent,
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

/** The quoted Next section, when one was read — never a paraphrase. */
function handoffClause(next: NextSummary | null): string | null {
  if (next === null) {
    return null
  }
  return `The latest handoff names what is next — its Next section, "as written":\n${next.text}`
}

/** Q4's draft for task start, its fields filled, the handoff's Next section quoted after. */
export function taskStartPrompt(item: PromptItem, next: NextSummary | null): string {
  return [
    'You are starting work on a temper task. Use the temper skill with the `temper` CLI if you have it.',
    `Start the task: ref \`${item.ref}\`, in ${homeClause(item)}. Read it with \`temper resource show ${item.id} --format json\`, follow its instructions (including any "How to hold this item" section), and set it in-progress through the skill's task-start flow.`,
    FALLBACK,
    handoffClause(next)
  ]
    .filter((part) => part !== null)
    .join('\n')
}

/** The same pattern for resuming an in-progress task. */
export function taskResumePrompt(item: PromptItem, next: NextSummary | null): string {
  return [
    'You are resuming work on a temper task. Use the temper skill with the `temper` CLI if you have it.',
    `Resume the task: ref \`${item.ref}\`, in ${homeClause(item)}. Read it with \`temper resource show ${item.id} --format json\`, follow its instructions (including any "How to hold this item" section), and continue it through the skill's task-resume flow, from its latest session.`,
    FALLBACK,
    handoffClause(next)
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
