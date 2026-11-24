// Named scenarios for `orca plugin check`: each renders the panel once on this machine, with
// the plugin's worker on the same host and the capabilities the manifest declares. The default
// `home` scenario renders the rail as the panel would draw it live. The `detail` scenario
// appears only when the caller names a record in ORCA_TEMPER_DETAIL_ID: a bare UUID is
// machine-local — the repo carries no temper resource ids — and the scenario seeds the
// detail stack the panel persisted on a previous run, so the check renders that record's
// detail against live temper, the way-out button lit by the scenario's own setting.
//
// The `look-*` scenarios render the rail's look from fixture answers instead of live temper,
// so Home, a task's detail and a goal's detail can be shot the same on any machine
// (`orca plugin shot . --scenario look-home --theme dark`). Their ids are placeholders. The
// `look-sheet*` scenarios stand the launcher sheet up from a seeded run (the sheet is held
// across runs, as the detail stack is), each outcome with it — `look-sheet-linked` with the
// task's linked workspace named before the confirm; `look-task-reopen` draws a task's detail
// whose stored link carries a session, so Reopen agent stands beside Resume task; the
// `look-home-tasks-backlog` and `look-home-goals-completed` draw Home's ways in by another status
// than the default (ruling 24); the `look-serves-*` scenarios draw Home's "this workspace"
// strip — linked to a task with its agents, unlinked, linked to a goal, no workspace in focus,
// and its consents withheld; `look-serves-agents` draws its agent rows as presses — a terminal
// agent's and a chat's, which says it opens the workspace — and `look-serves-focus-consent`
// those rows dark without `workspace:write`, the consent named; the `look-state-*` scenarios
// draw every region state: signed out, failed, loading, empty, and a withheld consent. The
// `look-skill*` scenarios draw agent skill readiness on Home (ready, missing, out of date,
// unknown, installed, install failed, read failed), and `look-sheet-skill-*` the sheet's line
// for a picked agent whose skill is missing or unknown. The `look-handoff-*` scenarios draw the
// latest-handoff card naming the tasks its session advanced, with its sheet open under it, for
// each branch of its prompt (decision ruling 28): one task in progress (Resume task), one done,
// one cancelled, several, none, a stage read that failed at the press, and a card read that
// failed. The `look-work-*` scenarios draw a
// task's work in Orca (ruling 26): a finished run offered to record beside recorded runs, one on
// this host with its dated Reopen and one elsewhere; a done task whose records leave its stage
// alone; and `look-sheet-claimed` the sheet naming temper's claim held elsewhere. The
// `look-explore*` scenarios draw Explore (build item 8): teams with one opened on its contexts
// and the people after them, and the region states — none readable, loading, failed and signed
// out; the `look-context*` scenarios draw a pressed context's view — its recently updated items
// under the search slot, and the same region states.
import { defineCheck } from 'orca/testing'
import type { HarnessReadiness, SkillReadinessOutput } from './skill-readiness/protocol'

const named = process.env['ORCA_TEMPER_DETAIL_ID']?.trim()

const GRANTED = [
  'settings:own',
  'workspace:read',
  'workspace:create',
  'agent:launch',
  'agent:read',
  'storage:own',
  'workspace:write'
]

const TASK_ID = '00000000-0000-7000-8000-000000000001'
const GOAL_ID = '00000000-0000-7000-8000-000000000002'
const SESSION_ID = '00000000-0000-7000-8000-000000000003'
const CONTEXT = '+team/workflows'
const CONTEXT_ID = '00000000-0000-7000-8000-000000000010'
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function row(n: number, title: string, docType: string, stage: string | null = null) {
  const id = `00000000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`
  return { id, ref: `row-${id}`, title, docType, contextRef: CONTEXT, updated: ago(n * 7), stage }
}

const WAYS: Record<string, { label: string; scope: string; rows: ReturnType<typeof row>[]; total: number }> = {
  goals: {
    label: 'goals',
    scope: 'active goals of yours',
    rows: [
      row(1, 'Temper is worked from inside Orca, on its own controls', 'goal', 'active'),
      row(2, 'A record body is edited where the person works', 'goal', 'active'),
      row(3, 'Every surface says what it omits', 'goal', 'active')
    ],
    total: 11
  },
  tasks: {
    label: 'in progress',
    scope: 'tasks in progress of yours',
    rows: [row(4, "The rail's look on Orca's controls: Home and detail", 'task', 'in-progress')],
    total: 1
  },
  sessions: {
    label: 'sessions',
    scope: 'sessions of yours',
    rows: [row(5, 'Session: the body view saves through its held base', 'session')],
    total: 42
  }
}

/** The other statuses the Goals and Tasks toggles read (ruling 24), by `<way>/<status>`. */
const BY_STATUS: Record<string, { scope: string; rows: ReturnType<typeof row>[]; total: number }> = {
  'tasks/backlog': {
    scope: 'backlog tasks of yours',
    rows: [
      row(8, 'The launcher sheet on Orca controls', 'task', 'backlog'),
      row(10, 'Explore: teams, then their contexts', 'task', 'backlog'),
      row(11, 'orca-temper imports the Show-more cap from temper-design', 'task', 'backlog')
    ],
    total: 23
  },
  'tasks/done': {
    scope: 'done tasks of yours',
    rows: [row(9, 'orca-temper Start and Resume', 'task', 'done')],
    total: 41
  },
  'goals/completed': {
    scope: 'completed goals of yours',
    rows: [
      row(12, 'The rail reads temper on a borrowed grant', 'goal', 'completed'),
      row(13, 'Every way in names its scope', 'goal', 'completed')
    ],
    total: 12
  }
}

/** A way-in answer for the asked way and status: the default reads WAYS, the others BY_STATUS. */
function wayAnswer(input: { id: string; bound: number; status?: string }) {
  const way = WAYS[input.id] ?? { label: input.id, scope: input.id, rows: [], total: 0 }
  const other = input.status === undefined ? undefined : BY_STATUS[`${input.id}/${input.status}`]
  return {
    state: 'ok' as const,
    id: input.id,
    ...way,
    ...(other ?? {}),
    status: input.status ?? null,
    bound: input.bound
  }
}

const TASK_DETAIL_TITLE = "The rail's look on Orca's controls: Home and detail"

const TASK_DETAIL = {
  id: TASK_ID,
  ref: `the-rails-look-on-orcas-controls-home-and-detail-${TASK_ID}`,
  title: "The rail's look on Orca's controls: Home and detail",
  docType: 'task',
  stage: 'in-progress',
  status: null,
  contextRef: CONTEXT,
  properties: [
    { label: 'doc_type', value: 'task' },
    { label: 'temper-stage', value: 'in-progress' },
    { label: 'temper-mode', value: 'build' },
    { label: 'temper-effort', value: 'medium' },
    { label: 'context', value: CONTEXT },
    { label: 'owner', value: 'someone' },
    { label: 'updated', value: ago(4) }
  ]
}

const GOAL_DETAIL = {
  id: GOAL_ID,
  ref: `temper-is-worked-from-inside-orca-${GOAL_ID}`,
  title: 'Temper is worked from inside Orca, on its own controls',
  docType: 'goal',
  stage: null,
  status: 'active',
  contextRef: CONTEXT,
  properties: [
    { label: 'doc_type', value: 'goal' },
    { label: 'temper-status', value: 'active' },
    { label: 'context', value: CONTEXT },
    { label: 'owner', value: 'someone' },
    { label: 'updated', value: ago(60) }
  ]
}

/** A workspace the task is already linked to, its agent session stored. */
const LINKED = {
  workspaceId: 'ws-linked',
  name: "temper-contrib · pt/the-rails-look",
  agent: 'claude' as string | null,
  sessionId: 'session-placeholder' as string | null
}

/** Agent skill readiness, a line per agent Orca can launch; placeholder paths. */
const SKILL_HOME = '/home/someone'
const AGENTS_SKILL = `${SKILL_HOME}/.agents/skills/temper`
const CLAUDE_SKILL = `${SKILL_HOME}/.claude/skills/temper`
const CLAUDE_WRITES = [CLAUDE_SKILL, `${SKILL_HOME}/.claude/commands/temper.md`]
const ANTIGRAVITY: HarnessReadiness = {
  agent: 'antigravity',
  name: 'Antigravity',
  target: null,
  state: 'unknown' as const,
  detail: 'it reads its skills from ~/.gemini/config/skills, which no temper install target writes'
}

/** Claude ready, Codex and OpenCode missing (the agents target), Antigravity unknown. */
const SKILL_MIXED: SkillReadinessOutput & { state: 'ok' } = {
  state: 'ok' as const,
  harnesses: [
    { agent: 'claude', name: 'Claude', target: 'claude', state: 'ready' as const, detail: CLAUDE_SKILL },
    { agent: 'codex', name: 'Codex', target: 'agents', state: 'missing' as const, detail: `nothing at ${AGENTS_SKILL}` },
    { agent: 'opencode', name: 'OpenCode', target: 'agents', state: 'missing' as const, detail: `nothing at ${AGENTS_SKILL}` },
    ANTIGRAVITY
  ],
  targets: [
    { target: 'agents', state: 'missing' as const, detail: `nothing at ${AGENTS_SKILL}`, writes: [AGENTS_SKILL] },
    { target: 'claude', state: 'ready' as const, detail: CLAUDE_SKILL, writes: CLAUDE_WRITES }
  ]
}

/** Claude out of date; the agents target unknown, its check having read another directory. */
const MISMATCH = `temper skill check reads ${CLAUDE_SKILL} (its skill.output setting), not ${AGENTS_SKILL}`
const SKILL_STALE: SkillReadinessOutput = {
  state: 'ok' as const,
  harnesses: [
    { agent: 'claude', name: 'Claude', target: 'claude', state: 'out-of-date' as const, detail: `${CLAUDE_SKILL} was installed for an older temper config` },
    { agent: 'codex', name: 'Codex', target: 'agents', state: 'unknown' as const, detail: MISMATCH },
    ANTIGRAVITY
  ],
  targets: [
    { target: 'agents', state: 'unknown' as const, detail: MISMATCH, writes: [AGENTS_SKILL] },
    { target: 'claude', state: 'out-of-date' as const, detail: `${CLAUDE_SKILL} was installed for an older temper config`, writes: CLAUDE_WRITES }
  ]
}

/** Every target ready, after an install. */
const SKILL_READY: SkillReadinessOutput = {
  ...SKILL_MIXED,
  harnesses: SKILL_MIXED.harnesses.map((harness) =>
    harness.target === 'agents' ? { ...harness, state: 'ready' as const, detail: AGENTS_SKILL } : harness
  ),
  targets: SKILL_MIXED.targets.map((target) => ({ ...target, state: 'ready' as const, detail: target.writes[0] }))
}

/** The focused workspace, as Orca names it to the panel. */
const FOCUSED = {
  workspaceId: 'identity:wt2:local:placeholder',
  branch: 'pt/the-rails-look',
  displayName: 'the-rails-look',
  terminals: []
}

const AGENTS = {
  agents: [
    { terminalId: 't-1', title: 'Claude', agent: 'claude', state: 'working', stateStartedAt: Date.now() - 12 * 60_000, sessionId: null, task: null },
    { terminalId: 't-2', title: 'Codex', agent: 'codex', state: 'done', stateStartedAt: Date.now() - 60 * 60_000, sessionId: null, task: null }
  ]
}

/** A terminal agent and a chat — the chat has no terminal, so its press opens the workspace. */
const CHAT_AGENTS = {
  agents: [
    AGENTS.agents[0],
    { terminalId: null, title: 'Claude chat', agent: 'claude', state: 'waiting', stateStartedAt: Date.now() - 3 * 60_000, sessionId: null, task: null }
  ]
}

const SERVES_TASK = {
  state: 'linked' as const,
  item: { itemId: TASK_ID, ref: `the-rails-look-on-orcas-controls-home-and-detail-${TASK_ID}`, title: "The rail's look on Orca's controls: Home and detail", docType: 'task', contextRef: CONTEXT },
  record: { state: 'ok' as const, detail: null as unknown }
}

/** A task's recorded Orca runs: one on this host, one on another (ruling 26). */
const WORK_RECORDS = [
  {
    artifactId: '00000000-0000-7000-8000-0000000000c2',
    agent: 'claude',
    workspaceName: 'temper-contrib · pt/the-rails-look',
    branch: 'pt/the-rails-look',
    sessionId: 'session-here',
    startedAt: ago(26 * 60),
    finishedAt: ago(24 * 60),
    outcome: 'success' as const,
    sessionNote: null,
    here: true
  },
  {
    artifactId: '00000000-0000-7000-8000-0000000000c1',
    agent: 'codex',
    workspaceName: 'temper-contrib · pt/rails-look-spike',
    branch: 'pt/rails-look-spike',
    sessionId: 'session-away',
    startedAt: ago(3 * 24 * 60),
    finishedAt: ago(3 * 24 * 60 - 45),
    outcome: 'interruption' as const,
    sessionNote: null,
    here: false
  }
]
/** A linked run that finished here and is not recorded yet. */
const RECORDABLE = {
  workspaceId: 'ws-recordable',
  workspaceName: 'temper-contrib · pt/the-rails-look-2',
  agent: 'claude',
  finishedAt: ago(12),
  outcome: 'success' as const
}
/** temper's claim, held by an agent elsewhere. */
/** Explore's contexts: two teams and a person, every context a placeholder. */
const EXPLORE = {
  state: 'ok' as const,
  contextCount: 5,
  owners: [
    {
      ownerRef: '+team',
      kind: 'team' as const,
      contexts: [
        { id: '00000000-0000-7000-8000-000000000011', ref: '+team/research', name: 'research', resourceCount: 214 },
        { id: CONTEXT_ID, ref: CONTEXT, name: 'workflows', resourceCount: 38 }
      ]
    },
    {
      ownerRef: '+corpus-team',
      kind: 'team' as const,
      contexts: [
        { id: '00000000-0000-7000-8000-000000000012', ref: '+corpus-team/papers', name: 'papers', resourceCount: 1290 },
        { id: '00000000-0000-7000-8000-000000000013', ref: '+corpus-team/brain', name: 'brain', resourceCount: 0 }
      ]
    },
    {
      ownerRef: '@someone',
      kind: 'person' as const,
      contexts: [{ id: '00000000-0000-7000-8000-000000000014', ref: '@someone/notes', name: 'notes', resourceCount: 12 }]
    }
  ]
}

/** A context's recently updated items, at the asked bound of the 38 it homes. */
const CONTEXT_ITEMS = [
  row(4, TASK_DETAIL_TITLE, 'task', 'in-progress'),
  row(8, 'The launcher sheet on Orca controls', 'task', 'backlog'),
  row(14, 'Decision: contrib work items live in contrib-workflows', 'decision'),
  row(15, 'Session: the handoff card names its tasks', 'session'),
  row(16, 'Explore: teams, then their contexts', 'task', 'in-progress'),
  row(17, 'The rail reads temper on a borrowed grant', 'goal', 'active'),
  row(18, 'Research: how contexts differ in purpose', 'research'),
  row(19, 'A concept: claim-style workflow contexts', 'concept')
]

/** The context view as the panel holds it after a press from Explore. */
const CONTEXT_ENTRY = { kind: 'context', id: CONTEXT_ID, ref: CONTEXT, name: 'workflows' }

const HELD_CLAIM = { claimId: 'c0ffee00-0000-4000-8000-000000000001', claimedAt: ago(95), heartbeatAt: ago(7) }

const LOOK = {
  capabilities: GRANTED,
  results: { 'workspace.readContext': FOCUSED, 'agents.list': AGENTS },
  settings: { webUrl: 'https://temper.example' },
  requests: {
    'temper.capabilities': () => ({ granted: GRANTED }),
    'temper.home.resume': () => ({
      state: 'ok' as const,
      resume: { resource: row(4, TASK_DETAIL.title, 'task', 'in-progress'), changedAt: ago(4) }
    }),
    'temper.home.handoff': () => ({
      state: 'ok' as const,
      sessionCount: 42,
      handoff: {
        id: SESSION_ID,
        ref: `session-the-body-view-saves-${SESSION_ID}`,
        title: 'Session: the body view saves through its held base',
        contextRef: CONTEXT,
        next: {
          heading: 'Next steps',
          text: "Land the rail's look pass: Home and detail first, then the launcher sheet.",
          truncated: false
        }
      }
    }),
    'temper.handoff.tasks': () => ({ state: 'ok' as const, tasks: [row(4, TASK_DETAIL.title, 'task', 'in-progress')] }),
    'temper.home.way-in': wayAnswer,
    'temper.home.places': () => ({
      state: 'ok' as const,
      rows: [{ id: CONTEXT_ID, ref: CONTEXT, name: 'workflows', lastChangedAt: ago(4) }],
      total: 3
    }),
    'temper.explore.contexts': () => EXPLORE,
    'temper.context.recent': (input: { id: string; bound: number }) => ({
      state: 'ok' as const,
      rows: CONTEXT_ITEMS.slice(0, input.bound),
      total: 38,
      bound: input.bound
    }),
    'temper.home.recent': () => ({
      state: 'ok' as const,
      rows: [
        row(4, TASK_DETAIL.title, 'task', 'in-progress'),
        row(6, 'Decision: a temper plugin for Orca', 'decision'),
        row(7, 'Design: the Orca rail look', 'research'),
        row(8, 'The launcher sheet on Orca controls', 'task', 'backlog')
      ],
      total: 120
    }),
    'temper.resource.detail': (input: { id: string }) =>
      input.id === GOAL_ID
        ? { state: 'ok' as const, detail: GOAL_DETAIL }
        : { state: 'ok' as const, detail: TASK_DETAIL },
    'temper.goal.tasks': () => ({
      state: 'ok' as const,
      rows: [
        row(4, TASK_DETAIL.title, 'task', 'in-progress'),
        row(8, 'The launcher sheet on Orca controls', 'task', 'backlog'),
        row(9, 'orca-temper Start and Resume', 'task', 'done')
      ],
      total: 14,
      bound: 8
    }),
    'temper.launch.projects': () => ({
      state: 'ok' as const,
      projects: [
        { id: 'proj-temper', name: 'temper', path: '/work/temper', hostId: 'local' },
        { id: 'proj-contrib', name: 'temper-contrib', path: '/work/temper-contrib', hostId: 'local' }
      ]
    }),
    'temper.launch.agents': () => ({
      state: 'ok' as const,
      agents: [
        { id: 'claude', name: 'Claude', isDefault: true },
        { id: 'codex', name: 'Codex', isDefault: false }
      ]
    }),
    'temper.launch.links': () => ({ state: 'ok' as const, links: [] as typeof LINKED[] }),
    'temper.work.records': () => ({ state: 'ok' as const, records: [] as typeof WORK_RECORDS, recordable: [] as typeof RECORDABLE[] }),
    'temper.task.claim': () => ({ state: 'ok' as const, claim: null as null | typeof HELD_CLAIM }),
    'temper.skill.readiness': () => SKILL_MIXED,
    'temper.serves': () => ({ ...SERVES_TASK, record: { state: 'ok' as const, detail: TASK_DETAIL } }),
    'temper.launch.task-handoff': () => ({
      state: 'ok' as const,
      handoff: {
        id: SESSION_ID,
        ref: `session-the-body-view-saves-${SESSION_ID}`,
        title: 'Session: the body view saves through its held base',
        next: {
          heading: 'Next steps',
          text: "- Land the rail's look pass on Home and detail\n- Then the launcher sheet and the region states, each shot in light and dark",
          truncated: false
        }
      }
    })
  }
}

/** The sheet Resume task opens on the in-progress task's detail. */
const TASK_SHEET = {
  kind: 'task-resume',
  from: 'detail',
  item: { id: TASK_ID, ref: TASK_DETAIL.ref, title: TASK_DETAIL.title, contextRef: CONTEXT },
  handoffNext: null
}

/** A task detail with its sheet open; `extra` adds a held outcome or a remembered project. */
function sheet(extra: Record<string, unknown> = {}) {
  return {
    plugin: {
      'detail-stack': [{ id: TASK_ID, ref: '', title: TASK_DETAIL.title, docType: 'task' }],
      'launch-compose': TASK_SHEET,
      ...extra
    }
  }
}

const REMEMBERED = { 'last-project-by-context': { [CONTEXT]: 'proj-contrib' } }

/** Every region refuses: temper is not connected. */
const NOT_CONNECTED = {
  state: 'not-connected' as const,
  message: 'temper is not connected — run `temper auth login`, then Refresh'
}

/** Every Home and detail request answered the same way. */
function allAnswer(answer: typeof NOT_CONNECTED) {
  return {
    'temper.home.resume': () => answer,
    'temper.home.handoff': () => answer,
    'temper.home.way-in': () => answer,
    'temper.home.places': () => answer,
    'temper.home.recent': () => answer,
    'temper.resource.detail': () => answer,
    'temper.goal.tasks': () => answer,
    'temper.explore.contexts': () => answer,
    'temper.context.recent': () => answer
  }
}

const FAILED = (what: string) => ({ state: 'failed' as const, message: `temper answered 503 on the ${what} read` })

const WITHHELD = GRANTED.filter((kind) => kind !== 'agent:launch' && kind !== 'workspace:create')

/** Home's temper lists all answered empty — so a shot reaches the regions drawn under them. */
const EMPTY_HOME = {
  'temper.home.resume': () => ({ state: 'ok' as const, resume: null }),
  'temper.home.handoff': () => ({ state: 'ok' as const, sessionCount: 0, handoff: null }),
  'temper.home.way-in': (input: { id: string; bound: number }) => {
    const way = WAYS[input.id] ?? { label: input.id, scope: input.id, rows: [], total: 0 }
    return { state: 'ok' as const, id: input.id, ...way, rows: [], total: 0, bound: input.bound }
  },
  'temper.home.places': () => ({ state: 'ok' as const, rows: [], total: 0 }),
  'temper.home.recent': () => ({ state: 'ok' as const, rows: [], total: 0 })
}

/** Home with the handoff card's sheet open, its stage reads answered in ask order — the carried
 *  sheet's read first, then the card's; the last answer stands for any later ask. */
function handoffScenario(...answers: unknown[]) {
  let asks = 0
  return {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.handoff.tasks': () => answers[Math.min(asks++, answers.length - 1)] as never
    },
    persisted: {
      plugin: {
        'detail-stack': [],
        'launch-compose': {
          kind: 'handoff-resume',
          from: 'home',
          item: {
            id: SESSION_ID,
            ref: `session-the-body-view-saves-${SESSION_ID}`,
            title: 'Session: the body view saves through its held base',
            contextRef: CONTEXT
          },
          handoffNext: {
            heading: 'Next steps',
            text: "Land the rail's look pass: Home and detail first, then the launcher sheet.",
            truncated: false
          }
        },
        ...REMEMBERED
      }
    }
  }
}

const tasksAnswer = (...tasks: ReturnType<typeof row>[]) => ({ state: 'ok' as const, tasks })

function seeded(entry: { id: string; docType: string }) {
  const title = entry.id === GOAL_ID ? GOAL_DETAIL.title : TASK_DETAIL.title
  return { plugin: { 'detail-stack': [{ id: entry.id, ref: '', title, docType: entry.docType }] } }
}

export default defineCheck({
  home: {},
  ...(named !== undefined && named !== ''
    ? {
        detail: {
          settings: { webUrl: 'https://temper.example' },
          persisted: {
            plugin: {
              'detail-stack': [{ id: named, ref: '', title: '', docType: '' }]
            }
          }
        }
      }
    : {}),
  'look-home': { ...LOOK, persisted: { plugin: { 'detail-stack': [] } } },
  // Home's ways in by status (ruling 24): Tasks by backlog, then Goals by completed.
  'look-home-tasks-backlog': {
    ...LOOK,
    persisted: { plugin: { 'detail-stack': [], 'way-in-status': { tasks: 'backlog' } } }
  },
  'look-home-goals-completed': {
    ...LOOK,
    persisted: { plugin: { 'detail-stack': [], 'way-in-status': { goals: 'completed' } } }
  },
  // Home's "this workspace" strip: linked to a task, its agents with their status words.
  'look-serves-linked': { ...LOOK, persisted: { plugin: { 'detail-stack': [] } } },
  'look-serves-unlinked': {
    ...LOOK,
    requests: { ...LOOK.requests, 'temper.serves': () => ({ state: 'unlinked' as const }) },
    results: { ...LOOK.results, 'agents.list': { agents: [AGENTS.agents[0]] } },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  'look-serves-goal': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.serves': () => ({
        state: 'linked' as const,
        item: { itemId: GOAL_ID, ref: GOAL_DETAIL.ref, title: GOAL_DETAIL.title, docType: 'goal', contextRef: CONTEXT },
        record: { state: 'ok' as const, detail: GOAL_DETAIL }
      })
    },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  'look-serves-record-failed': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.serves': () => ({
        ...SERVES_TASK,
        record: { state: 'failed' as const, message: 'temper answered 503 on the record read' }
      })
    },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  'look-serves-no-focus': {
    ...LOOK,
    results: { ...LOOK.results, 'workspace.readContext': null },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  'look-serves-consent': {
    ...LOOK,
    capabilities: GRANTED.filter((kind) => kind !== 'agent:read'),
    requests: {
      ...LOOK.requests,
      'temper.capabilities': () => ({ granted: GRANTED.filter((kind) => kind !== 'agent:read') })
    },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  'look-serves-agents': {
    ...LOOK,
    results: { ...LOOK.results, 'agents.list': CHAT_AGENTS },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  'look-serves-focus-consent': {
    ...LOOK,
    capabilities: GRANTED.filter((kind) => kind !== 'workspace:write'),
    results: { ...LOOK.results, 'agents.list': CHAT_AGENTS },
    requests: {
      ...LOOK.requests,
      'temper.capabilities': () => ({ granted: GRANTED.filter((kind) => kind !== 'workspace:write') })
    },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  'look-task': { ...LOOK, persisted: seeded({ id: TASK_ID, docType: 'task' }) },
  'look-goal': { ...LOOK, persisted: seeded({ id: GOAL_ID, docType: 'goal' }) },
  // The sheet, still owed a project: the confirm dark, its reason under the confirm row.
  'look-sheet': { ...LOOK, persisted: sheet() },
  // The sheet ready: the remembered project picked, the confirm lit.
  'look-sheet-ready': { ...LOOK, persisted: sheet(REMEMBERED) },
  // The task already has a linked workspace: the sheet names it before the confirm.
  'look-sheet-linked': {
    ...LOOK,
    requests: { ...LOOK.requests, 'temper.launch.links': () => ({ state: 'ok' as const, links: [LINKED] }) },
    persisted: sheet(REMEMBERED)
  },
  // A task whose stored link carries a session: Reopen agent, labelled with the workspace.
  'look-task-reopen': {
    ...LOOK,
    requests: { ...LOOK.requests, 'temper.launch.links': () => ({ state: 'ok' as const, links: [LINKED] }) },
    persisted: seeded({ id: TASK_ID, docType: 'task' })
  },
  // A task's work in Orca: a finished run to record, a recorded run here, one elsewhere.
  'look-work-record': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.work.records': () => ({ state: 'ok' as const, records: WORK_RECORDS, recordable: [RECORDABLE] })
    },
    persisted: seeded({ id: TASK_ID, docType: 'task' })
  },
  // A task done elsewhere: temper's done stage stands; Reopen is still offered from its record.
  'look-work-done': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.resource.detail': () => ({
        state: 'ok' as const,
        detail: {
          ...TASK_DETAIL,
          stage: 'done',
          properties: TASK_DETAIL.properties.map((entry) =>
            entry.label === 'temper-stage' ? { ...entry, value: 'done' } : entry
          )
        }
      }),
      'temper.work.records': () => ({ state: 'ok' as const, records: WORK_RECORDS, recordable: [] as typeof RECORDABLE[] })
    },
    persisted: seeded({ id: TASK_ID, docType: 'task' })
  },
  // The recorded runs could not be read: the region says so, and the detail stands.
  'look-work-failed': {
    ...LOOK,
    requests: { ...LOOK.requests, 'temper.work.records': () => FAILED('work records') },
    persisted: seeded({ id: TASK_ID, docType: 'task' })
  },
  // The sheet names temper's claim held elsewhere, with its heartbeat; the confirm stays lit.
  'look-sheet-claimed': {
    ...LOOK,
    requests: { ...LOOK.requests, 'temper.task.claim': () => ({ state: 'ok' as const, claim: HELD_CLAIM }) },
    persisted: sheet(REMEMBERED)
  },
  // The handoff card's Resume task, its sheet under the card.
  'look-sheet-home': {
    ...LOOK,
    persisted: {
      plugin: {
        'detail-stack': [],
        'launch-compose': {
          kind: 'handoff-resume',
          from: 'home',
          item: {
            id: SESSION_ID,
            ref: `session-the-body-view-saves-${SESSION_ID}`,
            title: 'Session: the body view saves through its held base',
            contextRef: CONTEXT
          },
          handoffNext: {
            heading: 'Next steps',
            text: "Land the rail's look pass: Home and detail first, then the launcher sheet.",
            truncated: false
          }
        },
        ...REMEMBERED
      }
    }
  },
  'look-sheet-launched': {
    ...LOOK,
    persisted: sheet({
      ...REMEMBERED,
      'launch-outcome': { state: 'launched', workspaceId: 'ws-new', terminalId: 't-new', linkError: null }
    })
  },
  'look-sheet-refused': {
    ...LOOK,
    persisted: sheet({
      ...REMEMBERED,
      'launch-outcome': {
        state: 'refused',
        message: 'The project is not reachable: its SSH host is offline.',
        code: 'not_permitted'
      }
    })
  },
  'look-sheet-never-ran': {
    ...LOOK,
    persisted: sheet({
      ...REMEMBERED,
      'launch-outcome': { state: 'failed', message: 'the launch request never answered: timeout' }
    })
  },
  // A withheld consent: the press and New workspace dark, each naming the consent in warning text.
  'look-state-consent': {
    ...LOOK,
    capabilities: WITHHELD,
    requests: { ...LOOK.requests, 'temper.capabilities': () => ({ granted: WITHHELD }) },
    persisted: sheet(REMEMBERED)
  },
  // Agent skill readiness on Home, its temper lists empty so the region under them is in frame:
  // a line per agent — ready, missing, unknown — and Install for the target not ready, its
  // path named before the press.
  'look-skill': {
    ...LOOK,
    requests: { ...LOOK.requests, ...EMPTY_HOME },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  // Out of date for Claude; the agents target unknown, its check having read another directory.
  'look-skill-stale': {
    ...LOOK,
    requests: { ...LOOK.requests, ...EMPTY_HOME, 'temper.skill.readiness': () => SKILL_STALE },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  // After the press: every line ready, the install's answer naming where it wrote.
  'look-skill-installed': {
    ...LOOK,
    requests: { ...LOOK.requests, ...EMPTY_HOME, 'temper.skill.readiness': () => SKILL_READY },
    persisted: {
      plugin: {
        'detail-stack': [],
        'skill-installs': {
          agents: { state: 'installed', target: 'agents', skillDir: AGENTS_SKILL, total: 14, changed: 14 }
        }
      }
    }
  },
  // A press whose install failed: still missing, the CLI's words under the press.
  'look-skill-install-failed': {
    ...LOOK,
    requests: { ...LOOK.requests, ...EMPTY_HOME },
    persisted: {
      plugin: {
        'detail-stack': [],
        'skill-installs': {
          agents: {
            state: 'failed',
            target: 'agents',
            message: `temper skill install failed: Permission denied (os error 13) at ${AGENTS_SKILL}`
          }
        }
      }
    }
  },
  // The readiness read itself failed: Orca would not name its agents.
  'look-skill-failed': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      ...EMPTY_HOME,
      'temper.skill.readiness': (): SkillReadinessOutput => ({ state: 'failed', message: 'Orca would not name its agents: exit 1' })
    },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  // The sheet with an agent whose skill is missing picked: named in warning text, confirm lit.
  'look-sheet-skill-missing': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.launch.agents': () => ({
        state: 'ok' as const,
        agents: [
          { id: 'codex', name: 'Codex', isDefault: true },
          { id: 'claude', name: 'Claude', isDefault: false }
        ]
      })
    },
    persisted: sheet(REMEMBERED)
  },
  // The sheet with an agent no target reaches: unknown, said muted.
  'look-sheet-skill-unknown': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.launch.agents': () => ({
        state: 'ok' as const,
        agents: [
          { id: 'antigravity', name: 'Antigravity', isDefault: true },
          { id: 'claude', name: 'Claude', isDefault: false }
        ]
      })
    },
    persisted: sheet(REMEMBERED)
  },
  // The handoff card's branches, each with its sheet open under the card.
  'look-handoff-resume': handoffScenario(tasksAnswer(row(4, TASK_DETAIL.title, 'task', 'in-progress'))),
  'look-handoff-done': handoffScenario(tasksAnswer(row(9, 'orca-temper Start and Resume', 'task', 'done'))),
  'look-handoff-cancelled': handoffScenario(tasksAnswer(row(9, 'orca-temper Start and Resume', 'task', 'cancelled'))),
  'look-handoff-several': handoffScenario(
    tasksAnswer(
      row(4, TASK_DETAIL.title, 'task', 'in-progress'),
      row(9, 'orca-temper Start and Resume', 'task', 'done')
    )
  ),
  'look-handoff-none': handoffScenario(tasksAnswer()),
  // The card read named an in-progress task; the press's read failed: the sheet says so. A
  // carried sheet asks its read as the panel sets up, before Home's refresh asks the card's.
  'look-handoff-unread': handoffScenario(
    FAILED('advanced tasks'),
    tasksAnswer(row(4, TASK_DETAIL.title, 'task', 'in-progress'))
  ),
  // The card's own read failed: the card stands, its tasks region saying so.
  'look-handoff-card-failed': { ...handoffScenario(FAILED('advanced tasks')), persisted: { plugin: { 'detail-stack': [] } } },
  'look-state-signed-out': {
    ...LOOK,
    requests: { ...LOOK.requests, ...allAnswer(NOT_CONNECTED) },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  // Failed regions beside the ones that answered.
  'look-state-failed': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.home.handoff': () => FAILED('latest handoff'),
      'temper.home.way-in': (input: { id: string; bound: number }) =>
        input.id === 'goals'
          ? FAILED('goals')
          : LOOK.requests['temper.home.way-in'](input)
    },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  // A goal whose record and linked tasks both failed.
  'look-state-failed-detail': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.resource.detail': () => FAILED('record'),
      'temper.goal.tasks': () => FAILED('linked tasks')
    },
    persisted: seeded({ id: GOAL_ID, docType: 'goal' })
  },
  // Explore: teams by name, one opened on its contexts, the people after them.
  'look-explore': {
    ...LOOK,
    persisted: { plugin: { 'detail-stack': [], 'active-tab': 'explore', 'explore-open': { '+team': true } } }
  },
  // No context is readable: the teams region keeps its words and its count at 0.
  'look-explore-empty': {
    ...LOOK,
    requests: { ...LOOK.requests, 'temper.explore.contexts': () => ({ state: 'ok' as const, owners: [], contextCount: 0 }) },
    persisted: { plugin: { 'detail-stack': [], 'active-tab': 'explore' } }
  },
  // The contexts read still out (an answer of null draws the still-out branch).
  'look-explore-loading': {
    ...LOOK,
    requests: { ...LOOK.requests, 'temper.explore.contexts': () => null as never },
    persisted: { plugin: { 'detail-stack': [], 'active-tab': 'explore' } }
  },
  'look-explore-failed': {
    ...LOOK,
    requests: { ...LOOK.requests, 'temper.explore.contexts': () => FAILED('contexts') },
    persisted: { plugin: { 'detail-stack': [], 'active-tab': 'explore' } }
  },
  // Signed out on Explore: the refusal stands over the tabs, and Explore draws nothing.
  'look-explore-signed-out': {
    ...LOOK,
    requests: { ...LOOK.requests, ...allAnswer(NOT_CONNECTED) },
    persisted: { plugin: { 'detail-stack': [], 'active-tab': 'explore' } }
  },
  // A pressed context: the search slot, then its recently updated items with Show more.
  'look-context': { ...LOOK, persisted: { plugin: { 'detail-stack': [CONTEXT_ENTRY] } } },
  'look-context-empty': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.context.recent': (input: { id: string; bound: number }) => ({ state: 'ok' as const, rows: [], total: 0, bound: input.bound })
    },
    persisted: { plugin: { 'detail-stack': [CONTEXT_ENTRY] } }
  },
  'look-context-loading': {
    ...LOOK,
    requests: { ...LOOK.requests, 'temper.context.recent': () => null as never },
    persisted: { plugin: { 'detail-stack': [CONTEXT_ENTRY] } }
  },
  'look-context-failed': {
    ...LOOK,
    requests: { ...LOOK.requests, 'temper.context.recent': () => FAILED("the context's items") },
    persisted: { plugin: { 'detail-stack': [CONTEXT_ENTRY] } }
  },
  // The grant lost after Home answered: the context view says temper is not connected.
  'look-context-signed-out': {
    ...LOOK,
    requests: { ...LOOK.requests, 'temper.context.recent': () => NOT_CONNECTED },
    persisted: { plugin: { 'detail-stack': [CONTEXT_ENTRY] } }
  },
  // Every list answered empty: each keeps its words and its count at 0.
  'look-state-empty': {
    ...LOOK,
    requests: { ...LOOK.requests, ...EMPTY_HOME },
    persisted: { plugin: { 'detail-stack': [] } }
  },
  // Reads still out: the house words over a skeleton. A check settles every request before
  // it draws, so a read that never answers cannot be staged; an answer of null draws the
  // same still-out branch the panel holds while a request is out.
  'look-state-loading': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.resource.detail': () => null as never,
      'temper.goal.tasks': () => null as never
    },
    persisted: seeded({ id: GOAL_ID, docType: 'goal' })
  }
})
