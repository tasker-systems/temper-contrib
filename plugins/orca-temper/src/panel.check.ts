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
// (`orca plugin shot . --scenario look-home --theme dark`). Their ids are placeholders.
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
    })
  }
}

function seeded(entry: { id: string; docType: string }) {
  return { plugin: { 'detail-stack': [{ id: entry.id, ref: '', title: '', docType: entry.docType }] } }
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
  'look-goal': { ...LOOK, persisted: seeded({ id: GOAL_ID, docType: 'goal' }) }
})
