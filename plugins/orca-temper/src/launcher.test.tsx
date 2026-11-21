// The launcher, pressed from the panel: the witness `orca_start_names_the_task_and_its_handoff`
// presses Start agent on a backlog task's detail — `workspace:create` granted — and the launch
// request the press sends carries the chosen project, the chosen agent, and a first prompt that
// names the task's full ref, its context, and its latest handoff's Next section; the person has
// read that prompt on the sheet before it is sent. It bites against main, where no launcher
// exists (there is nothing to press, and `temper.launch.go` is unknown to the worker — the
// companion worker tests in worker-launch.test.ts pin that end of the chain). The companions
// here: Resume defaults to this workspace when the task is already linked here, Work this goal
// sends the ruled goal prompt, the handoff card's Resume names the session and its Next, and a
// withheld consent draws the action disabled with the consent named — never attempted.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import type { JsonValue } from 'orca'
import * as panel from './panel'
import type {
  LatestHandoffOutput,
  LaunchInput,
  LaunchOutput,
  RecordDetailInput,
  RecordDetailOutput,
  TaskHandoffOutput
} from './protocol'

let mounted: TestPanel | undefined
afterEach(() => {
  void mounted?.unmount()
  mounted = undefined
})

const TASK_ID = '00000000-0000-7000-8000-0000000000d1'
const GOAL_ID = '00000000-0000-7000-8000-0000000000e1'
const TASK_REF = `the-launch-task-${TASK_ID}`
const TASK_CONTEXT = '+temper-dev/contrib-workflows'

const NEXT = { heading: 'Next steps', text: '- Record the witness runs\n- Run the live check', truncated: false }

/** The task's own newest linked session — its Next names this task's work, not someone else's. */
const TASK_NEXT = { heading: 'Next steps', text: '- Land the launcher gates\n- Keep the witness green', truncated: false }
const TASK_HANDOFF = {
  state: 'ok' as const,
  handoff: {
    id: '00000000-0000-7000-8000-0000000000b2',
    ref: 'the-tasks-session-00000000-0000-7000-8000-0000000000b2',
    title: "The task's session",
    next: TASK_NEXT
  }
}

/** The person's newest session — it worked ANOTHER task, and a task's prompt never quotes it. */
const HANDOFF = {
  state: 'ok' as const,
  sessionCount: 4,
  handoff: {
    id: '00000000-0000-7000-8000-0000000000d4',
    ref: 'handoff-note-00000000-0000-7000-8000-0000000000d4',
    title: 'The latest session note',
    contextRef: '+temper-dev/contrib',
    next: NEXT
  }
}

function taskDetail(stage: string) {
  return {
    state: 'ok' as const,
    detail: {
      id: TASK_ID,
      ref: TASK_REF,
      title: 'The item detail',
      docType: 'task',
      stage,
      status: null,
      contextRef: TASK_CONTEXT,
      properties: [
        { label: 'doc_type', value: 'task' },
        { label: 'temper-stage', value: stage }
      ]
    }
  }
}

const GOAL_DETAIL = {
  state: 'ok' as const,
  detail: {
    id: GOAL_ID,
    ref: `the-goal-${GOAL_ID}`,
    title: 'The in-force goal',
    docType: 'goal',
    stage: null,
    status: 'active',
    contextRef: TASK_CONTEXT,
    properties: [{ label: 'doc_type', value: 'goal' }]
  }
}

const PROJECTS = {
  state: 'ok' as const,
  projects: [
    { id: 'proj-one', name: 'temper', path: '/work/temper', hostId: 'local' },
    { id: 'proj-two', name: 'contrib', path: '/work/temper-contrib', hostId: 'local' }
  ]
}

const AGENTS = {
  state: 'ok' as const,
  agents: [
    { id: 'claude', name: 'Claude', isDefault: true },
    { id: 'opencode', name: 'OpenCode', isDefault: false }
  ]
}

const FOCUSED = {
  workspaceId: 'ws-current',
  branch: 'pt/thing',
  displayName: 'checkout · pt/thing',
  terminals: []
}

const ALL_GRANTED = [
  'settings:own',
  'workspace:read',
  'workspace:create',
  'agent:launch',
  'agent:read',
  'storage:own'
]

interface Served {
  launches: LaunchInput[]
}

function servedHost(options: {
  granted?: readonly string[]
  detail?: unknown
  links?: readonly object[]
  handoff?: unknown
  taskHandoff?: unknown
}): { host: ReturnType<typeof mockHost>; served: Served } {
  const served: Served = { launches: [] }
  const host = mockHost({
    capabilities: [...(options.granted ?? ALL_GRANTED)],
    results: { 'workspace.readContext': FOCUSED },
    ...(options.links !== undefined
      ? { storage: { 'launch-links': [...options.links] } as Record<string, JsonValue> }
      : {}),
    requests: {
      'temper.capabilities': () => ({ granted: [...(options.granted ?? ALL_GRANTED)] }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => (options.handoff ?? HANDOFF) as LatestHandoffOutput,
      'temper.home.way-in': () => ({ state: 'ok', id: 'goals', label: 'goals', scope: 'goals of yours', rows: [], total: 0, bound: 8 }),
      'temper.home.places': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.resource.detail': (input: RecordDetailInput): RecordDetailOutput => {
        if (options.detail !== undefined) {
          return options.detail as RecordDetailOutput
        }
        return input.id === GOAL_ID ? (GOAL_DETAIL as RecordDetailOutput) : (taskDetail('backlog') as RecordDetailOutput)
      },
      'temper.goal.tasks': () => ({ state: 'ok', rows: [], total: 0, bound: 8 }),
      'temper.launch.projects': () => PROJECTS,
      'temper.launch.agents': () => AGENTS,
      'temper.launch.task-handoff': () => (options.taskHandoff ?? TASK_HANDOFF) as TaskHandoffOutput,
      'temper.launch.go': (input: LaunchInput): LaunchOutput => {
        served.launches.push(input)
        return { state: 'launched', workspaceId: 'ws-new', terminalId: 't-new', linkError: null }
      }
    }
  })
  return { host, served }
}

function seededStack(top: { id: string; ref: string; title: string; docType: string }) {
  return { persisted: { plugin: { 'detail-stack': [top] } } }
}

/** The press-point button and the sheet's confirm carry the same words; the confirm is later. */
async function pressConfirm(label: string): Promise<void> {
  const buttons = mounted!.findAll({ type: 'Button', text: label })
  assert.ok(buttons.length >= 2, `the sheet is open — its own ${label} confirm stands beside the press`)
  await mounted!.press(buttons[buttons.length - 1])
  await mounted!.settled()
}

test('orca_start_names_the_task_and_its_handoff', async () => {
  const { host, served } = servedHost({})
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  // The press: Start agent on the backlog task's detail, lit by the granted consents.
  const start = mounted.find({ type: 'Button', text: 'Start agent' })
  assert.notEqual(start, null, 'Start agent is on a backlog task\'s detail')
  assert.notEqual(start?.disabled, true, 'it is lit by the granted consents')
  await mounted.press(start!)
  await mounted.settled()

  // The person sees the prompt before it is sent: the task's full ref and its context.
  assert.ok(
    mounted.find({ text: new RegExp(`Start the task: ref \`${TASK_REF}\``) }),
    'the sheet shows the ruled task-start prompt, the full ref named'
  )
  assert.ok(
    mounted.find({ text: new RegExp(TASK_CONTEXT.replace('+', '\\+')) }),
    'the prompt names the task\'s home context'
  )
  assert.ok(
    mounted.find({ text: /first prompt/ }),
    'the sheet says what the prompt is'
  )
  assert.ok(
    mounted.find({ text: /Land the launcher gates/ }),
    'the prompt quotes the task\'s OWN latest linked session\'s Next, before any send'
  )
  assert.equal(
    mounted.find({ text: /Record the witness runs/ }),
    null,
    'the person\'s latest session — another task\'s work — is never quoted'
  )
  assert.equal(served.launches.length, 0, 'nothing is sent until the person confirms')

  // The picks: the project from Orca's list, the agent from what Orca can launch.
  await mounted.select({ label: 'Project' }, 'proj-two')
  await mounted.select({ label: 'Agent' }, 'opencode')
  await pressConfirm('Start agent')

  assert.equal(served.launches.length, 1, 'one launch goes on the confirm')
  const launch = served.launches[0]
  assert.equal(launch.destination, 'new-workspace', 'Start defaults to a new workspace')
  assert.equal(launch.projectId, 'proj-two', 'the chosen project rides')
  assert.equal(launch.agent, 'opencode', 'the chosen agent rides')
  assert.equal(launch.item.id, TASK_ID)
  assert.ok(launch.prompt.includes(`ref \`${TASK_REF}\``), 'the prompt names the task\'s full ref')
  assert.ok(launch.prompt.includes(TASK_CONTEXT), 'the prompt names the task\'s context')
  assert.ok(
    launch.prompt.includes('- Land the launcher gates'),
    'the prompt names the task\'s own latest handoff\'s Next section'
  )
  assert.ok(
    !launch.prompt.includes('Record the witness runs'),
    'the person\'s latest session is never quoted in the task\'s place'
  )
  assert.ok(
    launch.prompt.includes('temper skill check'),
    'the prompt carries the no-skill fallback'
  )
  // No temper write is made on the press: the only requests ever issued are reads, the
  // launch picks, and the one launch — there is no write request in this protocol at all.
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('resume on a task linked here defaults to this workspace and calls for an agent launch', async () => {
  const { host, served } = servedHost({
    detail: taskDetail('in-progress'),
    links: [
      {
        workspaceId: 'ws-current',
        itemId: TASK_ID,
        ref: TASK_REF,
        contextRef: TASK_CONTEXT,
        startedAt: '2026-11-20T00:00:00Z'
      }
    ]
  })
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  const resume = mounted.find({ type: 'Button', text: 'Resume agent' })
  assert.notEqual(resume, null, 'Resume agent is on an in-progress task\'s detail')
  await mounted.press(resume!)
  await mounted.settled()

  assert.ok(
    mounted.find({ text: /Resume the task:/ }),
    'the sheet shows the resume prompt, its full ref and context named'
  )
  await pressConfirm('Resume agent')

  assert.equal(served.launches.length, 1)
  const launch = served.launches[0]
  assert.equal(launch.destination, 'this-workspace', 'Resume defaults here when the task is linked here')
  assert.equal(launch.workspaceId, 'ws-current', 'the launch lands in this workspace')
  assert.ok(launch.prompt.includes('Resume the task:'), 'the resume prompt asks for the task-resume flow')
  assert.ok(launch.prompt.includes('- Land the launcher gates'), 'the task\'s own Next section rides')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('a task with no linked session has no handoff quoted — the prompt says so', async () => {
  const { host, served } = servedHost({
    taskHandoff: { state: 'ok' as const, handoff: null }
  })
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  await mounted.press(mounted.find({ type: 'Button', text: 'Start agent' })!)
  await mounted.settled()

  assert.ok(
    mounted.find({ text: /The task has no handoff yet/ }),
    'the sheet\'s prompt says the task has no handoff yet'
  )
  assert.equal(mounted.find({ text: /Record the witness runs/ }), null, 'no other session is quoted')

  await mounted.select({ label: 'Project' }, 'proj-one')
  await pressConfirm('Start agent')

  assert.equal(served.launches.length, 1)
  assert.ok(served.launches[0].prompt.includes('The task has no handoff yet'), 'the sent prompt says it too')
  assert.ok(!served.launches[0].prompt.includes('Record the witness runs'))
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('Work this goal sends the ruled goal prompt', async () => {
  const { host, served } = servedHost({ detail: GOAL_DETAIL })
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: GOAL_ID, ref: '', title: '', docType: 'goal' })
  })
  await mounted.settled()

  const work = mounted.find({ type: 'Button', text: 'Work this goal' })
  assert.notEqual(work, null, 'Work this goal is on an active goal\'s detail')
  await mounted.press(work!)
  await mounted.settled()

  // The default agent is pre-picked (Claude is default); only the project is asked for, and
  // the remembered pick per context lights it from the last launch into one — here none yet.
  await mounted.select({ label: 'Project' }, 'proj-one')
  await pressConfirm('Work this goal')

  assert.equal(served.launches.length, 1)
  const launch = served.launches[0]
  assert.equal(launch.agent, 'claude', 'the default agent stands pre-picked')
  assert.equal(launch.item.id, GOAL_ID)
  assert.ok(
    launch.prompt.includes('You are taking up a temper goal. Use the temper skill'),
    'the goal prompt is the ruled Q4a wording'
  )
  assert.ok(launch.prompt.includes(`Goal: ref \`${GOAL_DETAIL.detail.ref}\``), 'the goal\'s full ref is named')
  assert.ok(
    launch.prompt.includes('File nothing until the person agrees.'),
    'the goal prompt files nothing until the person agrees'
  )
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('the remembered project picks the project for the same context', async () => {
  const { host, served } = servedHost({
    detail: taskDetail('backlog')
  })
  mounted = await mount(panel, {
    host,
    persisted: {
      plugin: {
        'detail-stack': [{ id: TASK_ID, ref: '', title: '', docType: 'task' }],
        'last-project-by-context': { [TASK_CONTEXT]: 'proj-one' }
      }
    }
  })
  await mounted.settled()

  await mounted.press(mounted.find({ type: 'Button', text: 'Start agent' })!)
  await mounted.settled()
  await pressConfirm('Start agent')

  assert.equal(served.launches.length, 1)
  assert.equal(served.launches[0].projectId, 'proj-one', 'the remembered pick for this context stands')
  assert.deepEqual(mounted.errors, [])
})

test('the handoff card\'s Resume names the session and its Next', async () => {
  const { host, served } = servedHost({})
  mounted = await mount(panel, { host })
  await mounted.settled()

  const resume = mounted.find({ type: 'Button', text: 'Resume' })
  assert.notEqual(resume, null, 'Resume is on the latest-handoff card')
  await mounted.press(resume!)
  await mounted.settled()

  assert.ok(
    mounted.find({ text: new RegExp(`session ref \`${HANDOFF.handoff.ref}\``) }),
    'the prompt names the handoff session\'s full ref'
  )
  assert.ok(mounted.find({ text: /Run the live check/ }), 'the Next section is quoted before send')

  await mounted.select({ label: 'Project' }, 'proj-one')
  await pressConfirm('Resume')

  assert.equal(served.launches.length, 1)
  assert.equal(served.launches[0].item.id, HANDOFF.handoff.id)
  assert.equal(served.launches[0].destination, 'new-workspace')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('a withheld launch consent draws the action disabled, named, never attempted', async () => {
  const withoutLaunch = ALL_GRANTED.filter((kind) => kind !== 'agent:launch')
  const { host, served } = servedHost({ granted: withoutLaunch })
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  const start = mounted.find({ type: 'Button', text: 'Start agent' })
  assert.equal(start?.disabled, true, 'Start agent is dark without the launch consent')
  assert.ok(
    mounted.find({
      text: "Needs the 'Start and resume agents in your workspaces, local and SSH' consent."
    }),
    'the missing consent is named in Orca\'s own words'
  )
  assert.equal(served.launches.length, 0, 'nothing was attempted')
  assert.deepEqual(mounted.errors, [])
})

test('without workspace:create the new-workspace destination is named and the this-workspace path stays open', async () => {
  const withoutCreate = ALL_GRANTED.filter((kind) => kind !== 'workspace:create')
  const { host, served } = servedHost({ granted: withoutCreate })
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  await mounted.press(mounted.find({ type: 'Button', text: 'Start agent' })!)
  await mounted.settled()

  assert.ok(
    mounted.find({ text: new RegExp(`Needs the 'Create workspaces`) }),
    'the New workspace destination names the withheld consent'
  )
  // The this-workspace path still works (Q9): switch destination and confirm.
  await mounted.select({ label: 'Where the agent works' }, 'this-workspace')
  await mounted.settled()
  await pressConfirm('Start agent')

  assert.equal(served.launches.length, 1)
  assert.equal(served.launches[0].destination, 'this-workspace')
  assert.equal(served.launches[0].workspaceId, 'ws-current')
  assert.deepEqual(mounted.errors, [])
})

/** Document order from an element path: its index segments, compared left to right. */
function drawnBefore(a: { path: string }, b: { path: string }): boolean {
  const pa = a.path.match(/\d+/g)?.map(Number) ?? []
  const pb = b.path.match(/\d+/g)?.map(Number) ?? []
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) {
      return (pa[i] ?? 0) < (pb[i] ?? 0)
    }
  }
  return pa.length < pb.length
}

test('the handoff card\'s sheet opens below the card\'s omission sentence, outside the card', async () => {
  const { host } = servedHost({})
  mounted = await mount(panel, { host })
  await mounted.settled()

  const resume = mounted.find({ type: 'Button', text: 'Resume' })
  assert.equal(resume?.props.variant, 'solid', 'Resume is the card\'s one primary act')
  assert.equal(resume?.props.tone, 'accent')
  assert.equal(resume?.props.icon, 'play')
  await mounted.press(resume!)
  await mounted.settled()

  const card = mounted.find({ type: 'Card', label: 'latest handoff' })
  const omission = mounted.find({ text: '1 of 4 sessions of yours; 3 not shown.' })
  const sheet = mounted.find({ type: 'Heading', text: 'Resume' })
  assert.ok(card && omission && sheet, 'the card, its omission sentence and the sheet are drawn')
  assert.ok(omission.path.startsWith(card.path), 'the omission sentence is the card\'s own')
  assert.ok(!sheet.path.startsWith(card.path), 'the sheet stands outside the card')
  assert.ok(drawnBefore(omission, sheet), 'the sheet opens after the omission sentence, never between')
  assert.deepEqual(mounted.errors, [])
})
