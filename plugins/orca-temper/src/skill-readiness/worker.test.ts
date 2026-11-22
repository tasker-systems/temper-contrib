// Agent skill readiness, the worker's end, over deps.ts standing in for both CLIs. Pinned here:
// a readiness read runs `temper skill check --target <t> --format json` once per target the
// launchable agents need and reads each agent from its own target's check; an agent no target
// reaches is unknown without any check run; a readiness read never installs; and an install
// runs `temper skill install --target <t> --format json` only when the panel asks for it,
// answering with the directory the CLI wrote.
import { afterEach, assert, mockHost, mountWorker, test } from 'orca/testing'
import { deps, type CommandResult } from '../deps'
import * as main from '../worker'

const original = { ...deps }
afterEach(() => {
  deps.run = original.run
  deps.runOrca = original.runOrca
  deps.home = original.home
})

const HOME = '/home/someone'

function agentsAnswer(ids: string[]): CommandResult {
  return {
    code: 0,
    stderr: '',
    stdout: JSON.stringify({
      ok: true,
      result: { agents: ids.map((id, index) => ({ id, name: id.toUpperCase(), default: index === 0 })) }
    })
  }
}

function checkAnswer(dir: string, extra: Record<string, unknown> = {}): CommandResult {
  return {
    code: 0,
    stderr: '',
    stdout: JSON.stringify({
      skill_dir: dir,
      skill_dir_found: true,
      expected_files: 14,
      missing_files: [],
      config_hash: { status: 'up_to_date' },
      command_wrapper: { status: 'not_applicable' },
      ...extra
    })
  }
}

/** Stands both CLIs in; every temper run is recorded. */
function stand(options: { agents: string[]; check: (target: string) => CommandResult; install?: CommandResult }) {
  const runs: string[][] = []
  deps.home = () => HOME
  deps.runOrca = async () => agentsAnswer(options.agents)
  deps.run = async (args) => {
    runs.push([...args])
    if (args[0] === 'skill' && args[1] === 'check') {
      return options.check(String(args[3]))
    }
    if (args[0] === 'skill' && args[1] === 'install') {
      return options.install ?? { code: 0, stderr: '', stdout: '{}' }
    }
    return { code: 1, stderr: 'unexpected', stdout: '' }
  }
  return runs
}

test('the check is read per target, each agent from its own target\'s check', async () => {
  const runs = stand({
    agents: ['claude', 'codex', 'opencode'],
    check: (target) =>
      target === 'claude'
        ? checkAnswer(`${HOME}/.claude/skills/temper`, { command_wrapper: { status: 'found', path: 'p' } })
        : checkAnswer(`${HOME}/.agents/skills/temper`, { skill_dir_found: false })
  })
  const worker = await mountWorker(main, { host: mockHost({}) })
  const answer = await worker.request('temper.skill.readiness')

  assert.deepEqual(
    runs,
    [
      ['skill', 'check', '--target', 'agents', '--format', 'json'],
      ['skill', 'check', '--target', 'claude', '--format', 'json']
    ],
    'one check per target the agents need, and nothing else run'
  )
  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  const state = Object.fromEntries(answer.harnesses.map((harness) => [harness.agent, harness.state]))
  assert.deepEqual(state, { claude: 'ready', codex: 'missing', opencode: 'missing' })
  const agents = answer.targets.find((target) => target.target === 'agents')
  assert.deepEqual(agents?.writes, [`${HOME}/.agents/skills/temper`], 'the paths an install writes ride with the target')
})

test('a harness with no known target shows unknown, and no check runs for it', async () => {
  const runs = stand({ agents: ['antigravity', 'pi'], check: () => checkAnswer('x') })
  const worker = await mountWorker(main, { host: mockHost({}) })
  const answer = await worker.request('temper.skill.readiness')

  assert.equal(runs.length, 0, 'no target is needed, so no check runs')
  assert.equal(answer.state, 'ok')
  if (answer.state !== 'ok') return
  assert.deepEqual(
    answer.harnesses.map((harness) => [harness.agent, harness.state, harness.target]),
    [
      ['antigravity', 'unknown', null],
      ['pi', 'unknown', null]
    ]
  )
  assert.deepEqual(answer.targets, [], 'no Install is offered without a target')
})

test('a check that looked in another directory leaves its agents unknown', async () => {
  stand({ agents: ['codex'], check: () => checkAnswer(`${HOME}/.claude/skills/temper`) })
  const worker = await mountWorker(main, { host: mockHost({}) })
  const answer = await worker.request('temper.skill.readiness')
  assert.equal(answer.state === 'ok' ? answer.harnesses[0].state : null, 'unknown')
})

test('when Orca will not name its agents the read fails, and nothing is checked', async () => {
  const runs = stand({ agents: [], check: () => checkAnswer('x') })
  deps.runOrca = async () => ({ code: 1, stderr: 'orca: not running', stdout: '' })
  const worker = await mountWorker(main, { host: mockHost({}) })
  const answer = await worker.request('temper.skill.readiness')
  assert.equal(answer.state, 'failed')
  assert.ok(answer.state === 'failed' && answer.message.includes('orca: not running'))
  assert.equal(runs.length, 0)
})

test('readiness never installs; Install runs only when asked, and names the directory it wrote', async () => {
  const runs = stand({
    agents: ['claude', 'codex'],
    check: () => checkAnswer(`${HOME}/.agents/skills/temper`, { skill_dir_found: false }),
    install: {
      code: 0,
      stderr: '',
      stdout: JSON.stringify({ skill_dir: `${HOME}/.agents/skills/temper`, up_to_date: false, total: 14, changed: ['SKILL.md', 'reference.md'] })
    }
  })
  const worker = await mountWorker(main, { host: mockHost({}) })
  await worker.request('temper.skill.readiness')
  await worker.request('temper.skill.readiness')
  assert.equal(
    runs.filter((args) => args[1] === 'install').length,
    0,
    'no readiness read installs anything'
  )

  const installed = await worker.request('temper.skill.install', { target: 'agents' })
  assert.deepEqual(runs[runs.length - 1], ['skill', 'install', '--target', 'agents', '--format', 'json'])
  assert.deepEqual(installed, {
    state: 'installed',
    target: 'agents',
    skillDir: `${HOME}/.agents/skills/temper`,
    total: 14,
    changed: 2
  })
})

test('an install for a target the plugin does not name is refused before the CLI runs', async () => {
  const runs = stand({ agents: [], check: () => checkAnswer('x') })
  const worker = await mountWorker(main, { host: mockHost({}) })
  const answer = await worker.request('temper.skill.install', { target: 'everywhere' as never })
  assert.equal(answer.state, 'failed')
  assert.equal(runs.length, 0)
})

test('a failing install says what the CLI said', async () => {
  stand({
    agents: [],
    check: () => checkAnswer('x'),
    install: { code: 1, stderr: '', stdout: '{"error":"permission denied"}' }
  })
  const worker = await mountWorker(main, { host: mockHost({}) })
  const answer = await worker.request('temper.skill.install', { target: 'claude' })
  assert.equal(answer.state, 'failed')
  assert.ok(answer.state === 'failed' && answer.message.includes('permission denied'))
})
