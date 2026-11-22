// Agent skill readiness, pressed from the panel: Home draws one line per agent Orca can launch
// in words; an Install press for a target not ready names the paths it writes before the press,
// and only the press sends an install; and the launcher sheet names a missing skill for the
// agent picked while its confirm stays lit.
import { afterEach, assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from '../panel'
import type { SkillInstallInput, SkillInstallOutput, SkillReadinessOutput } from './protocol'

let mounted: TestPanel | undefined
afterEach(() => {
  void mounted?.unmount()
  mounted = undefined
})

const AGENTS_DIR = '/home/someone/.agents/skills/temper'

const READINESS: SkillReadinessOutput = {
  state: 'ok',
  harnesses: [
    { agent: 'claude', name: 'Claude', target: 'claude', state: 'ready', detail: '/home/someone/.claude/skills/temper' },
    { agent: 'codex', name: 'Codex', target: 'agents', state: 'missing', detail: `nothing at ${AGENTS_DIR}` },
    { agent: 'antigravity', name: 'Antigravity', target: null, state: 'unknown', detail: 'it reads its skills from ~/.gemini/config/skills, which no temper install target writes' }
  ],
  targets: [
    { target: 'claude', state: 'ready', detail: '/home/someone/.claude/skills/temper', writes: ['/home/someone/.claude/skills/temper', '/home/someone/.claude/commands/temper.md'] },
    { target: 'agents', state: 'missing', detail: `nothing at ${AGENTS_DIR}`, writes: [AGENTS_DIR] }
  ]
}

/** The same agents once the agents target was installed. */
const INSTALLED: SkillReadinessOutput = {
  state: 'ok',
  harnesses: READINESS.state === 'ok'
    ? READINESS.harnesses.map((harness) =>
        harness.target === 'agents' ? { ...harness, state: 'ready' as const, detail: AGENTS_DIR } : harness
      )
    : [],
  targets: READINESS.state === 'ok'
    ? READINESS.targets.map((target) => ({ ...target, state: 'ready' as const }))
    : []
}

const TASK_ID = '00000000-0000-7000-8000-0000000000d1'
const GRANTED = ['settings:own', 'workspace:read', 'workspace:create', 'agent:launch', 'agent:read', 'storage:own']

function host(options: { installs: SkillInstallInput[]; readiness?: () => SkillReadinessOutput }) {
  return mockHost({
    capabilities: GRANTED,
    requests: {
      'temper.capabilities': () => ({ granted: GRANTED }),
      'temper.home.resume': () => ({ state: 'ok', resume: null }),
      'temper.home.handoff': () => ({ state: 'ok', sessionCount: 0, handoff: null }),
      'temper.home.way-in': (input: { id: string; bound: number }) => ({
        state: 'ok', id: input.id, label: input.id, scope: input.id, rows: [], total: 0, bound: input.bound
      }),
      'temper.home.places': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.home.recent': () => ({ state: 'ok', rows: [], total: 0 }),
      'temper.skill.readiness': options.readiness ?? (() => READINESS),
      'temper.skill.install': (input: SkillInstallInput): SkillInstallOutput => {
        options.installs.push(input)
        return { state: 'installed', target: input.target, skillDir: AGENTS_DIR, total: 14, changed: 14 }
      },
      'temper.resource.detail': () => ({
        state: 'ok',
        detail: {
          id: TASK_ID,
          ref: `the-task-${TASK_ID}`,
          title: 'The task',
          docType: 'task',
          stage: 'backlog',
          status: null,
          contextRef: '+team/workflows',
          properties: []
        }
      }),
      'temper.launch.projects': () => ({
        state: 'ok',
        projects: [{ id: 'proj', name: 'temper', path: '/work/temper', hostId: 'local' }]
      }),
      'temper.launch.agents': () => ({
        state: 'ok',
        agents: [
          { id: 'claude', name: 'Claude', isDefault: true },
          { id: 'codex', name: 'Codex', isDefault: false }
        ]
      }),
      'temper.launch.links': () => ({ state: 'ok', links: [] }),
      'temper.launch.task-handoff': () => ({ state: 'ok', handoff: null })
    }
  })
}

test('Home draws one readiness line per agent, in words — unknown where no target is known', async () => {
  mounted = await mount(panel, { host: host({ installs: [] }), persisted: { plugin: { 'detail-stack': [] } } })
  await mounted.settled()

  assert.ok(mounted.find({ type: 'Heading', text: 'agent skill' }), 'the region is on Home')
  const claude = mounted.find({ type: 'ListItem', label: 'Claude' })
  const codex = mounted.find({ type: 'ListItem', label: 'Codex' })
  const antigravity = mounted.find({ type: 'ListItem', label: 'Antigravity' })
  assert.ok(claude && codex && antigravity, 'one line per agent Orca names')
  assert.ok(String(claude.props.description).startsWith('ready · '))
  assert.ok(String(codex.props.description).startsWith('missing · '))
  assert.ok(String(antigravity.props.description).startsWith('unknown · '), 'never guessed ready')
  assert.deepEqual(mounted.errors, [])
})

test('Install is offered only where a target is not ready, names its path, and runs only on the press', async () => {
  const installs: SkillInstallInput[] = []
  let reads = 0
  mounted = await mount(panel, {
    host: host({
      installs,
      readiness: () => {
        reads += 1
        return installs.length === 0 ? READINESS : INSTALLED
      }
    }),
    persisted: { plugin: { 'detail-stack': [] } }
  })
  await mounted.settled()

  assert.equal(mounted.find({ type: 'Button', text: 'Install for Claude' }), null, 'a ready target offers no Install')
  const press = mounted.find({ type: 'Button', text: 'Install for Codex' })
  assert.ok(press, 'the missing target offers Install, named by the agents it reaches')
  assert.ok(
    mounted.find({ text: `Writes ${AGENTS_DIR} (temper skill install --target agents).` }),
    'the path it writes is said before the press'
  )
  assert.equal(installs.length, 0, 'nothing is installed before the press')
  const before = reads

  await mounted.press(press!)
  await mounted.settled()

  assert.deepEqual(installs, [{ target: 'agents' }], 'one install, for the pressed target')
  assert.ok(reads > before, 'readiness is read again after the install')
  assert.ok(
    String(mounted.find({ type: 'ListItem', label: 'Codex' })?.props.description).startsWith('ready · '),
    'the line follows the new read'
  )
  assert.equal(mounted.find({ type: 'Button', text: 'Install for Codex' }), null, 'a ready target offers no Install')
  assert.ok(
    mounted.find({ type: 'Callout', label: `Installed to ${AGENTS_DIR}` }),
    'the answer, naming where it wrote, stays once the target is ready'
  )
})

test('the sheet names a missing skill for the agent picked, and the confirm stays lit', async () => {
  mounted = await mount(panel, {
    host: host({ installs: [] }),
    persisted: {
      plugin: {
        'detail-stack': [{ id: TASK_ID, ref: '', title: '', docType: 'task' }],
        'last-project-by-context': { '+team/workflows': 'proj' }
      }
    }
  })
  await mounted.settled()
  const start = mounted.find({ type: 'Button', text: 'Start agent' })
  await mounted.press(start!)
  await mounted.settled()

  assert.ok(mounted.find({ text: 'Claude has the temper skill.' }), 'the default agent is ready, said muted')

  await mounted.select({ label: 'Agent' }, 'codex')
  const line = mounted.find({ text: /^Codex's temper skill is missing/ })
  assert.ok(line, 'the picked agent\'s missing skill is named')
  assert.equal(line.props.tone, 'warning')
  const confirms = mounted.findAll({ type: 'Button', text: 'Start agent' })
  assert.notEqual(confirms[confirms.length - 1].disabled, true, 'a missing skill never blocks the launch')
})
