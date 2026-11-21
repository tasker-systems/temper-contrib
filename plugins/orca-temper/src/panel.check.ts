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
// `look-state-*` scenarios
// draw every region state: signed out, failed, loading, empty, and a withheld consent.
import { defineCheck } from 'orca/testing'

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

const LOOK = {
  capabilities: GRANTED,
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
    'temper.home.way-in': (input: { id: string; bound: number }) => {
      const way = WAYS[input.id] ?? { label: input.id, scope: input.id, rows: [], total: 0 }
      return { state: 'ok' as const, id: input.id, ...way, bound: input.bound }
    },
    'temper.home.places': () => ({
      state: 'ok' as const,
      rows: [{ ref: CONTEXT, name: 'workflows', lastChangedAt: ago(4) }],
      total: 3
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
    'temper.goal.tasks': () => answer
  }
}

const FAILED = (what: string) => ({ state: 'failed' as const, message: `temper answered 503 on the ${what} read` })

const WITHHELD = GRANTED.filter((kind) => kind !== 'agent:launch' && kind !== 'workspace:create')

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
  // Every list answered empty: each keeps its words and its count at 0.
  'look-state-empty': {
    ...LOOK,
    requests: {
      ...LOOK.requests,
      'temper.home.resume': () => ({ state: 'ok' as const, resume: null }),
      'temper.home.handoff': () => ({ state: 'ok' as const, sessionCount: 0, handoff: null }),
      'temper.home.way-in': (input: { id: string; bound: number }) => {
        const way = WAYS[input.id] ?? { label: input.id, scope: input.id, rows: [], total: 0 }
        return { state: 'ok' as const, id: input.id, ...way, rows: [], total: 0, bound: input.bound }
      },
      'temper.home.places': () => ({ state: 'ok' as const, rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok' as const, rows: [], total: 0 })
    },
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
