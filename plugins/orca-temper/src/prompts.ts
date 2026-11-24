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

/**
 * Session start from the latest handoff card on Home — the prompt for a session that advanced
 * no task. `check`, when given, is one more line the agent reads before the Next section: a
 * stage read that failed, or a task in a stage no branch names, is said there, never guessed.
 */
export function handoffResumePrompt(
  item: PromptItem,
  next: NextSummary | null,
  check: string | null = null
): string {
  return [
    "You are starting a session from the person's latest temper handoff. Use the temper skill with the `temper` CLI if you have it.",
    `The handoff: session ref \`${item.ref}\`, in ${homeClause(item)}. Read it with \`temper resource show ${item.id} --format json\` and start from its Next section, through the skill's session-start flow if one is named.`,
    FALLBACK,
    check,
    handoffClause(next)
  ]
    .filter((part) => part !== null)
    .join('\n')
}

/** A task the handoff's session advanced (its `advances` edge), with its stage as temper read it. */
export interface AdvancedTask extends PromptItem {
  /** temper's stage word at the read (`in-progress`, `done`, …); null when the task carries none. */
  stage: string | null
}

/** A stage in words, for a prompt: `in-progress` reads "in progress"; none is said as none. */
function stageWords(stage: string | null): string {
  return stage === null ? 'no stage' : stage.replace(/-/g, ' ')
}

/** "ref `…` ("title"), in context `…`" — how a prompt names an advanced task. */
function taskNaming(task: AdvancedTask): string {
  return `ref \`${task.ref}\` ("${task.title}"), in ${homeClause(task)}`
}

/**
 * The handoff's session advanced one task, and temper holds it done or cancelled: the agent is
 * told so, and reads the Next section as follow-ups to check against temper — it reopens
 * nothing and claims nothing unless a follow-up is its own task (decision ruling 28).
 */
export function handoffFollowUpPrompt(
  session: PromptItem,
  task: AdvancedTask,
  next: NextSummary | null
): string {
  const closed = task.stage === 'cancelled' ? 'cancelled' : 'done'
  return [
    "You are following up the person's latest temper handoff. Use the temper skill with the `temper` CLI if you have it.",
    `The handoff: session ref \`${session.ref}\`, in ${homeClause(session)}. Read it with \`temper resource show ${session.id} --format json\`.`,
    `The task this session advanced is ${closed}: ${taskNaming(task)}; temper holds its stage as ${closed}. Do not reopen it, and claim nothing — unless a follow-up is its own task, which you hold through that task's own "How to hold this item".`,
    "Read the session's Next section as follow-ups to check against temper, not as work to resume: some may already be done, or filed as tasks of their own.",
    FALLBACK,
    next === null ? 'The session carries no Next section.' : `Its Next section, as written:\n${next.text}`
  ].join('\n')
}

/**
 * The handoff's session advanced several tasks: each is named with its stage, and the agent asks
 * the person which to continue, acting on none until told (decision ruling 28).
 */
export function handoffChoicePrompt(
  session: PromptItem,
  tasks: readonly AdvancedTask[],
  next: NextSummary | null
): string {
  return [
    "You are picking up the person's latest temper handoff. Use the temper skill with the `temper` CLI if you have it.",
    `The handoff: session ref \`${session.ref}\`, in ${homeClause(session)}. Read it with \`temper resource show ${session.id} --format json\`.`,
    `This session advanced ${tasks.length} tasks; their stages as temper held them when this prompt was made:`,
    ...tasks.map((task) => `- ${taskNaming(task)} — ${stageWords(task.stage)}`),
    'Ask the person which task to continue before you act on any of them: start, resume, reopen and claim nothing until they say.',
    FALLBACK,
    handoffClause(next)
  ]
    .filter((part) => part !== null)
    .join('\n')
}

/** What the press read of the tasks the session advanced: their list, or a failure's words. */
export type AdvancedTasksRead = { state: 'ok'; tasks: readonly AdvancedTask[] } | { state: 'failed'; message: string }

/** Which prompt the handoff card's press sends, decided on the stages as temper read them. */
export type HandoffBranch =
  | { kind: 'resume-task'; task: AdvancedTask }
  | { kind: 'follow-up'; task: AdvancedTask }
  | { kind: 'no-task' }
  | { kind: 'several'; tasks: readonly AdvancedTask[] }
  /** One task in a stage no branch names (backlog, or none): the session start, with a check. */
  | { kind: 'unnamed-stage'; task: AdvancedTask }
  /** The stage read failed: the session start, with a line telling the agent to check first. */
  | { kind: 'unread'; message: string }

export function handoffBranch(advanced: AdvancedTasksRead): HandoffBranch {
  if (advanced.state === 'failed') {
    return { kind: 'unread', message: advanced.message }
  }
  const [only, ...rest] = advanced.tasks
  if (only === undefined) {
    return { kind: 'no-task' }
  }
  if (rest.length > 0) {
    return { kind: 'several', tasks: advanced.tasks }
  }
  if (only.stage === 'in-progress') {
    return { kind: 'resume-task', task: only }
  }
  if (only.stage === 'done' || only.stage === 'cancelled') {
    return { kind: 'follow-up', task: only }
  }
  return { kind: 'unnamed-stage', task: only }
}

/** The label the branch's press and sheet carry: Resume task only for one in-progress task. */
export function handoffLabel(branch: HandoffBranch): 'Resume task' | 'Continue from handoff' {
  return branch.kind === 'resume-task' ? 'Resume task' : 'Continue from handoff'
}

/** The check line a failed stage read adds to the session-start prompt. */
export const UNREAD_CHECK =
  "The tasks this session advanced could not be read from temper, so their state is not known here. Before acting on its Next section, check the state of each task it advanced (the session's `advances` edges) in temper, and reopen or claim nothing that is done or cancelled."

/** The handoff card's prompt, for the branch the press read. */
export function handoffPrompt(session: PromptItem, next: NextSummary | null, branch: HandoffBranch): string {
  switch (branch.kind) {
    case 'resume-task':
      return taskResumePrompt(branch.task, {
        hasSession: true,
        session: { id: session.id, ref: session.ref, title: session.title },
        next
      })
    case 'follow-up':
      return handoffFollowUpPrompt(session, branch.task, next)
    case 'several':
      return handoffChoicePrompt(session, branch.tasks, next)
    case 'no-task':
      return handoffResumePrompt(session, next)
    case 'unnamed-stage':
      return handoffResumePrompt(
        session,
        next,
        `This session advanced one task: ${taskNaming(branch.task)}; temper holds its stage as ${stageWords(branch.task.stage)}. Check its state before acting on its Next section, and claim it only through its own "How to hold this item".`
      )
    case 'unread':
      return handoffResumePrompt(session, next, UNREAD_CHECK)
  }
}

/** Q4a's ruled wording for an active goal, verbatim but with the refs filled. */
export function goalWorkPrompt(item: PromptItem): string {
  return `You are taking up a temper goal. Use the temper skill with the \`temper\` CLI if you have it, following its working-a-goal guidance. Goal: ref \`${item.ref}\`, context \`${item.contextRef ?? 'none — it is cogmap-homed'}\`. Read what is in force (the register, its current witnessed state, recent sessions and linked tasks), then propose the next chunk of work and the clause it advances. File nothing until the person agrees.`
}
