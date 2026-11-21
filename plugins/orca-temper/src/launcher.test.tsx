// The launcher, pressed from the panel: the witness `orca_start_names_the_task_and_its_handoff`
// presses Start agent on a backlog task's detail — `workspace:create` granted — and the launch
// request the press sends carries the chosen project, the chosen agent, and a first prompt that
// names the task's full ref, its context, and its latest handoff's Next section; the person has
// read that prompt on the sheet before it is sent. It bites against main, where no launcher
// exists (there is nothing to press, and `temper.launch.go` is unknown to the worker — the
// companion worker tests in worker-launch.test.ts pin that end of the chain). The companions
// here: Resume task opens Start's sheet with the resume prompt and launches into a new
// workspace, naming a linked workspace before the confirm (decision ruling 23; never into an
// existing workspace); Reopen agent appears only where a stored link carries a
// session, labelled with the workspace's name, and asks for exactly that link; Work this goal
// sends the ruled goal prompt; the handoff card's Resume task names the session and its Next;
// and a withheld consent draws the action disabled with the consent named — never attempted.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type {
  LatestHandoffOutput,
  LaunchInput,
  LaunchOutput,
  LinkedWorkspace,
  RecordDetailInput,
  RecordDetailOutput,
  ReopenInput,
  ReopenOutput,
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
  reopens: ReopenInput[]
}

function servedHost(options: {
  granted?: readonly string[]
  detail?: unknown
  links?: readonly LinkedWorkspace[]
  handoff?: unknown
  taskHandoff?: unknown
  launch?: LaunchOutput
  reopen?: ReopenOutput
}): { host: ReturnType<typeof mockHost>; served: Served } {
  const served: Served = { launches: [], reopens: [] }
  const host = mockHost({
    capabilities: [...(options.granted ?? ALL_GRANTED)],
    results: { 'workspace.readContext': FOCUSED },
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
        return options.launch ?? { state: 'launched', workspaceId: 'ws-new', terminalId: 't-new', linkError: null }
      },
      'temper.launch.links': () => ({ state: 'ok', links: [...(options.links ?? [])] }),
      'temper.reopen.go': (input: ReopenInput): ReopenOutput => {
        served.reopens.push(input)
        return options.reopen ?? { state: 'reopened', terminalId: 't-back', started: true }
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
  assert.equal(launch.destination, 'new-workspace', 'Start launches into a new workspace')
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

const LINKED: LinkedWorkspace = {
  workspaceId: 'ws-linked',
  name: 'contrib · pt/the-launch-task',
  agent: 'claude',
  sessionId: 'sess-linked'
}

test('Resume task opens Start\'s sheet with the resume prompt and launches through workspace.create', async () => {
  const { host, served } = servedHost({ detail: taskDetail('in-progress') })
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  const resume = mounted.find({ type: 'Button', text: 'Resume task' })
  assert.notEqual(resume, null, 'Resume task is on an in-progress task\'s detail')
  await mounted.press(resume!)
  await mounted.settled()

  assert.ok(mounted.find({ type: 'Card', label: 'Resume task' }), 'the sheet is titled with the act')
  assert.ok(mounted.find({ text: /Resume the task:/ }), 'the sheet shows the resume-from-handoff prompt')
  assert.equal(mounted.find({ type: 'RadioGroup' }), null, 'no this-workspace destination is offered')
  assert.equal(mounted.find({ text: /Already linked/ }), null, 'an unlinked task names no workspace')
  await mounted.select({ label: 'Project' }, 'proj-two')
  await pressConfirm('Resume task')

  assert.equal(served.launches.length, 1)
  const launch = served.launches[0]
  assert.equal(launch.destination, 'new-workspace', 'Resume task goes through workspace.create')
  assert.ok(!('workspaceId' in launch), 'never into an existing workspace')
  assert.equal(launch.projectId, 'proj-two')
  assert.ok(launch.prompt.includes('Resume the task:'), 'the resume prompt asks for the task-resume flow')
  assert.ok(launch.prompt.includes('- Land the launcher gates'), 'the task\'s own Next section rides')
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('the sheet names an existing linked workspace before the confirm', async () => {
  const { host, served } = servedHost({ detail: taskDetail('in-progress'), links: [LINKED] })
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  await mounted.press(mounted.find({ type: 'Button', text: 'Resume task' })!)
  await mounted.settled()

  const card = mounted.find({ type: 'Card', label: 'Resume task' })!
  const note = mounted.find({ type: 'Callout', label: `Already linked to the workspace ${LINKED.name}` })
  assert.ok(note && note.path.startsWith(card.path), 'the sheet names the linked workspace')
  const confirm = mounted.findAll({ type: 'Button', text: 'Resume task' }).find((b) => b.path.startsWith(card.path))!
  assert.ok(drawnBefore(note, confirm), 'named before the confirm')
  assert.ok(mounted.find({ text: /makes another workspace for the same work/ }), 'it says what the confirm makes')

  await mounted.select({ label: 'Project' }, 'proj-one')
  await pressConfirm('Resume task')
  assert.equal(served.launches[0]?.destination, 'new-workspace', 'the confirm still makes a new workspace')
  assert.deepEqual(mounted.errors, [])
})

test('Reopen agent appears only where a stored link carries a session, and asks for that link', async () => {
  const unsessioned: LinkedWorkspace = { workspaceId: 'ws-old', name: 'contrib · pt/older', agent: null, sessionId: null }
  const { host, served } = servedHost({ detail: taskDetail('in-progress'), links: [unsessioned, LINKED] })
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  const reopens = mounted.findAll({ type: 'Button', text: /^Reopen agent/ })
  assert.deepEqual(
    reopens.map((button) => button.text),
    [`Reopen agent — ${LINKED.name}`],
    'one Reopen, labelled with the workspace\'s name; a link without a session offers none'
  )
  assert.equal(reopens[0]?.props.variant, 'outline', 'beside the view\'s one solid act')
  await mounted.press(reopens[0]!)
  await mounted.settled()

  assert.deepEqual(served.reopens, [{ itemId: TASK_ID, workspaceId: LINKED.workspaceId }])
  assert.equal(served.launches.length, 0, 'no launch, no temper prompt')
  assert.ok(mounted.find({ type: 'Callout', label: `The agent session was reopened in ${LINKED.name}.` }))
  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(mounted.refusals, [])
})

test('no Reopen agent without a stored session', async () => {
  const { host } = servedHost({ detail: taskDetail('in-progress') })
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()
  assert.equal(mounted.find({ type: 'Button', text: /^Reopen agent/ }), null)
  assert.deepEqual(mounted.errors, [])
})

test('Reopen agent refused by Orca says what Orca said', async () => {
  const { host } = servedHost({
    detail: taskDetail('in-progress'),
    links: [LINKED],
    reopen: { state: 'refused', code: 'invalid_params', message: 'no such session' }
  })
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()
  await mounted.press(mounted.find({ type: 'Button', text: /^Reopen agent/ })!)
  await mounted.settled()
  assert.equal(mounted.find({ type: 'Callout', label: 'Orca refused' })?.props.tone, 'danger')
  assert.ok(mounted.find({ text: 'no such session (invalid_params)' }))
  assert.deepEqual(mounted.errors, [])
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

test('the handoff card\'s Resume task names the session and its Next', async () => {
  const { host, served } = servedHost({})
  mounted = await mount(panel, { host })
  await mounted.settled()

  const resume = mounted.find({ type: 'Button', text: 'Resume task' })
  assert.notEqual(resume, null, 'Resume task is on the latest-handoff card')
  await mounted.press(resume!)
  await mounted.settled()

  assert.ok(
    mounted.find({ text: new RegExp(`session ref \`${HANDOFF.handoff.ref}\``) }),
    'the prompt names the handoff session\'s full ref'
  )
  assert.ok(mounted.find({ text: /Run the live check/ }), 'the Next section is quoted before send')

  await mounted.select({ label: 'Project' }, 'proj-one')
  await pressConfirm('Resume task')

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
  const sentence = mounted.find({
    text: "Start agent needs the 'Start and resume agents in your workspaces, local and SSH' consent."
  })
  assert.ok(sentence, 'the missing consent is named in Orca\'s own words, with its act')
  assert.equal(sentence.props.tone, 'warning', 'in warning text')
  const row = mounted.findAll({ type: 'Row' }).find((r) => start!.path.startsWith(r.path))
  assert.ok(row && !sentence.path.startsWith(row.path), 'said under the act row, so the row stays aligned')
  assert.equal(served.launches.length, 0, 'nothing was attempted')
  assert.deepEqual(mounted.errors, [])
})

test('without workspace:create the press is dark and names the consent — no other path is offered', async () => {
  const withoutCreate = ALL_GRANTED.filter((kind) => kind !== 'workspace:create')
  const { host, served } = servedHost({ granted: withoutCreate })
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()

  const start = mounted.find({ type: 'Button', text: 'Start agent' })
  assert.equal(start?.disabled, true, 'every launch needs workspace:create')
  assert.ok(
    mounted.find({ text: /^Start agent needs the 'Create workspaces/ }),
    'the withheld consent is named with its act'
  )
  assert.equal(served.launches.length, 0)
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

  const resume = mounted.find({ type: 'Button', text: 'Resume task' })
  assert.equal(resume?.props.variant, 'solid', 'Resume task is the card\'s one primary act')
  assert.equal(resume?.props.tone, 'accent')
  assert.equal(resume?.props.icon, 'play')
  await mounted.press(resume!)
  await mounted.settled()

  const card = mounted.find({ type: 'Card', label: 'latest handoff' })
  const omission = mounted.find({ text: '1 of 4 sessions of yours; 3 not shown.' })
  const sheet = mounted.find({ type: 'Card', label: 'Resume task' })
  assert.ok(card && omission && sheet, 'the card, its omission sentence and the sheet are drawn')
  assert.ok(omission.path.startsWith(card.path), 'the omission sentence is the card\'s own')
  assert.ok(!sheet.path.startsWith(card.path), 'the sheet stands outside the card')
  assert.ok(drawnBefore(omission, sheet), 'the sheet opens after the omission sentence, never between')
  assert.deepEqual(mounted.errors, [])
})

/** Opens Start agent's sheet on the backlog task's detail. */
async function openStartSheet(options: Parameters<typeof servedHost>[0] = {}) {
  const { host, served } = servedHost(options)
  mounted = await mount(panel, {
    host,
    ...seededStack({ id: TASK_ID, ref: '', title: '', docType: 'task' })
  })
  await mounted.settled()
  await mounted.press(mounted.find({ type: 'Button', text: 'Start agent' })!)
  await mounted.settled()
  return served
}

test('the sheet is a card titled with its act, its prompt wrapping so every line is readable', async () => {
  await openStartSheet()

  const card = mounted!.find({ type: 'Card', label: 'Start agent' })
  assert.ok(card, 'the sheet is a card titled with its act')
  assert.match(String(card.props.description), /first prompt — sent when you confirm/)
  const prompt = mounted!.find({ type: 'CodeView' })
  assert.ok(prompt && prompt.path.startsWith(card.path), 'the prompt stands inside the card')
  assert.equal(prompt.props.wrap, true, 'the prompt wraps — no line clips at the rail edge')
  assert.equal(prompt.props.label, 'first prompt')
  assert.ok(
    String(prompt.props.code).includes(`Start the task: ref \`${TASK_REF}\``),
    'the whole prompt the confirm sends is the code shown'
  )
  assert.equal(mounted!.find({ type: 'Code' }), null, 'no unwrapped code block is left to clip')
  assert.deepEqual(mounted!.errors, [])
  assert.deepEqual(mounted!.warnings, [])
})

test('the confirm row: one solid accent confirm, Cancel ghost beside it, the reason under the row', async () => {
  await openStartSheet()

  const card = mounted!.find({ type: 'Card', label: 'Start agent' })!
  const confirm = mounted!.findAll({ type: 'Button', text: 'Start agent' }).find((b) => b.path.startsWith(card.path))
  const cancel = mounted!.find({ type: 'Button', text: 'Cancel' })
  assert.ok(confirm && cancel)
  assert.equal(confirm.props.variant, 'solid')
  assert.equal(confirm.props.tone, 'accent')
  assert.equal(confirm.props.icon, 'play')
  assert.equal(confirm.disabled, true, 'dark until a project is picked')
  assert.equal(cancel.props.variant, 'ghost')
  const solids = mounted!.findAll({ type: 'Button' }).filter((b) => b.props.variant === 'solid')
  assert.deepEqual(solids.map((b) => b.path), [confirm.path], 'with the sheet open, its confirm is the one solid act')
  const row = mounted!.findAll({ type: 'Row' }).find((r) => confirm.path.startsWith(r.path) && cancel.path.startsWith(r.path))
  assert.ok(row, 'confirm and Cancel stand in one row')
  assert.equal(row.props.align, 'center')
  const reason = mounted!.find({ text: 'Pick a project.' })
  assert.ok(reason, 'the not-ready reason is said')
  assert.ok(!reason.path.startsWith(row.path), 'the reason stands under the row, not in it')
  assert.ok(drawnBefore(row, reason))

  await mounted!.select({ label: 'Project' }, 'proj-one')
  assert.equal(mounted!.find({ text: 'Pick a project.' }), null)
  const lit = mounted!.findAll({ type: 'Button', text: 'Start agent' }).find((b) => b.path.startsWith(card.path))
  assert.notEqual(lit?.disabled, true, 'a picked project lights the confirm')
  assert.deepEqual(mounted!.errors, [])
})

test('launched is a success callout in the sheet, with Close', async () => {
  await openStartSheet()
  await mounted!.select({ label: 'Project' }, 'proj-one')
  await pressConfirm('Start agent')

  const done = mounted!.find({ type: 'Callout', label: 'The agent was launched.' })
  assert.equal(done?.props.tone, 'success')
  assert.ok(mounted!.find({ type: 'Button', text: 'Close' }))
  assert.equal(mounted!.find({ text: /✓/ }), null, 'the callout carries its own glyph')
  assert.deepEqual(mounted!.errors, [])
})

test('Orca refusing a launch is a danger callout with Orca\'s own message and code', async () => {
  await openStartSheet({
    launch: { state: 'refused', message: 'the project is not reachable over SSH', code: 'not_permitted' }
  })
  await mounted!.select({ label: 'Project' }, 'proj-one')
  await pressConfirm('Start agent')

  const refused = mounted!.find({ type: 'Callout', label: 'Orca refused' })
  assert.equal(refused?.props.tone, 'danger')
  assert.ok(mounted!.find({ text: 'the project is not reachable over SSH (not_permitted)' }))
  assert.ok(mounted!.find({ type: 'CodeView' }), 'the sheet stays open to try again')
  assert.deepEqual(mounted!.errors, [])
})

test('a launch that never ran is a warning callout, titled in words', async () => {
  await openStartSheet({ launch: { state: 'failed', message: 'the worker lost its grant' } })
  await mounted!.select({ label: 'Project' }, 'proj-one')
  await pressConfirm('Start agent')

  const failed = mounted!.find({ type: 'Callout', label: 'The launch never ran' })
  assert.equal(failed?.props.tone, 'warning')
  assert.ok(mounted!.find({ text: 'the worker lost its grant' }))
  assert.equal(mounted!.find({ text: /⚠/ }), null)
  assert.deepEqual(mounted!.errors, [])
})

test('a missing consent on a carried sheet darkens the confirm and names it in warning text under the row', async () => {
  const withoutCreate = ALL_GRANTED.filter((kind) => kind !== 'workspace:create')
  const { host } = servedHost({ granted: withoutCreate })
  mounted = await mount(panel, {
    host,
    persisted: {
      plugin: {
        'detail-stack': [{ id: TASK_ID, ref: '', title: '', docType: 'task' }],
        'launch-compose': {
          kind: 'task-start',
          from: 'detail',
          item: { id: TASK_ID, ref: TASK_REF, title: 'The item detail', contextRef: TASK_CONTEXT },
          handoffNext: null
        },
        'last-project-by-context': { [TASK_CONTEXT]: 'proj-one' }
      }
    }
  })
  await mounted.settled()

  const card = mounted.find({ type: 'Card', label: 'Start agent' })!
  const sentence = mounted.findAll({ type: 'Text', text: /^Needs the 'Create workspaces/ }).filter((s) => s.path.startsWith(card.path))
  assert.ok(sentence.length > 0, 'the withheld consent is named in the sheet')
  assert.ok(sentence.every((s) => s.props.tone === 'warning'), 'in warning text')
  const confirm = mounted.findAll({ type: 'Button', text: 'Start agent' }).find((b) => b.path.startsWith(card.path))
  assert.equal(confirm?.disabled, true)
  assert.deepEqual(mounted.errors, [])
})

test('a sheet carried from the last run draws again with its reads asked, on its own item only', async () => {
  const compose = {
    kind: 'task-start',
    from: 'detail',
    item: { id: TASK_ID, ref: TASK_REF, title: 'The item detail', contextRef: TASK_CONTEXT },
    handoffNext: null
  }
  const { host } = servedHost({})
  mounted = await mount(panel, {
    host,
    persisted: {
      plugin: {
        'detail-stack': [{ id: TASK_ID, ref: '', title: '', docType: 'task' }],
        'launch-compose': compose,
        'launch-outcome': { state: 'refused', message: 'Orca said no', code: null }
      }
    }
  })
  await mounted.settled()
  assert.ok(mounted.find({ type: 'Card', label: 'Start agent' }), 'the carried sheet draws')
  assert.ok(mounted.find({ type: 'Select', label: 'Project' }), 'its reads were asked again')
  assert.ok(mounted.find({ type: 'Callout', label: 'Orca refused' }), 'its outcome is held with it')
  await mounted.unmount()

  const other = servedHost({ detail: { ...taskDetail('backlog'), detail: { ...taskDetail('backlog').detail, id: GOAL_ID } } })
  mounted = await mount(panel, {
    host: other.host,
    persisted: {
      plugin: {
        'detail-stack': [{ id: GOAL_ID, ref: '', title: '', docType: 'task' }],
        'launch-compose': compose
      }
    }
  })
  await mounted.settled()
  assert.equal(mounted.find({ type: 'Card' }), null, 'a sheet opened on one record never stands on another')
  assert.deepEqual(mounted.errors, [])
})
