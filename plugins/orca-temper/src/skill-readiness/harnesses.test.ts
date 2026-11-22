// The reach map and the check's reading, pinned without a CLI: each agent Orca launches maps to
// the install target the spike found reaching it, or unknown with a reason; and a
// `temper skill check --format json` report is read for its target — ready only when it looked
// in that target's own directory and found everything current.
import { assert, test } from 'orca/testing'
import { agentReach, readCheck, targetWrites } from './harnesses'

const HOME = '/home/someone'

/** A check report as the CLI prints it, for `dir`, with overrides. */
function report(dir: string, extra: Record<string, unknown> = {}) {
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

test('each agent maps to the target the spike found reaching it', () => {
  for (const agent of ['codex', 'gemini', 'cursor', 'copilot', 'opencode', 'kimi']) {
    assert.deepEqual(agentReach(agent), { target: 'agents' }, `${agent} reads ~/.agents/skills`)
  }
  assert.deepEqual(agentReach('claude'), { target: 'claude' }, 'Claude Code reads ~/.claude/skills only')
  assert.deepEqual(agentReach('claude-agent-teams'), { target: 'claude' })
})

test('an agent no target reaches is unknown, with why', () => {
  const kiro = agentReach('kiro')
  assert.equal(kiro.target, null)
  assert.ok(kiro.target === null && /~\/\.kiro\/skills/.test(kiro.reason), 'its own skill home is named')
  const pi = agentReach('pi')
  assert.ok(pi.target === null && /no skills discovery/.test(pi.reason))
  assert.equal(agentReach('some-agent-from-a-later-orca').target, null, 'an agent the map never saw is unknown')
})

test('a target names every path its install writes', () => {
  assert.deepEqual(targetWrites('agents', HOME), [`${HOME}/.agents/skills/temper`])
  assert.deepEqual(targetWrites('claude', `${HOME}/`), [
    `${HOME}/.claude/skills/temper`,
    `${HOME}/.claude/commands/temper.md`
  ])
})

test('a complete, current check in the target\'s own directory is ready', () => {
  assert.equal(readCheck('agents', HOME, report(`${HOME}/.agents/skills/temper`)).state, 'ready')
  assert.equal(
    readCheck('claude', HOME, report(`${HOME}/.claude/skills/temper`, { command_wrapper: { status: 'found', path: 'x' } })).state,
    'ready'
  )
})

test('a check that looked somewhere else is unknown, naming where it looked', () => {
  // The CLI's check reads its skill.output setting whatever --target says.
  const reading = readCheck('agents', HOME, report(`${HOME}/.claude/skills/temper`))
  assert.equal(reading.state, 'unknown', 'never ready on another directory\'s files')
  assert.ok(reading.detail.includes(`${HOME}/.claude/skills/temper`), 'the directory read is named')
  assert.ok(reading.detail.includes(`${HOME}/.agents/skills/temper`), 'and the one the target installs to')
})

test('missing, partly missing, stale and wrapperless read as such', () => {
  const dir = `${HOME}/.claude/skills/temper`
  assert.equal(readCheck('claude', HOME, report(dir, { skill_dir_found: false })).state, 'missing')
  const partial = readCheck('claude', HOME, report(dir, { missing_files: ['SKILL.md', 'teams.md'] }))
  assert.equal(partial.state, 'missing')
  assert.ok(partial.detail.startsWith('2 of 14'), 'how many are missing is said')
  assert.equal(
    readCheck('claude', HOME, report(dir, { config_hash: { status: 'stale', embedded: 'a', current: 'b' } })).state,
    'out-of-date'
  )
  assert.equal(
    readCheck('claude', HOME, report(dir, { command_wrapper: { status: 'missing', path: `${HOME}/.claude/commands/temper.md` } })).state,
    'out-of-date'
  )
})

test('whatever the check cannot say is unknown, never ready', () => {
  const dir = `${HOME}/.agents/skills/temper`
  assert.equal(readCheck('agents', HOME, report(dir, { config_hash: { status: 'unknown' } })).state, 'unknown')
  assert.equal(readCheck('agents', HOME, report(dir, { config_hash: undefined })).state, 'unknown')
  const failed = readCheck('agents', HOME, { code: 2, stdout: '', stderr: 'error: unexpected argument\nmore' })
  assert.equal(failed.state, 'unknown')
  assert.ok(failed.detail.includes('unexpected argument'), 'the CLI\'s own first line is said')
  assert.equal(readCheck('agents', HOME, { code: 0, stdout: 'not json', stderr: '' }).state, 'unknown')
  assert.equal(readCheck('agents', HOME, { code: 0, stdout: '{}', stderr: '' }).state, 'unknown')
})
