// `temper.agent.focus`, the worker's end of taking the person to an agent: a known terminal is
// focused (`terminal.focus`, answering Orca's `focused`), a chat — no terminal — opens its
// workspace (`workspace.open`), a refusal says what Orca said, and nothing touches temper or
// the plugin's storage: the press moves Orca's view only (decision ruling 26).
import { assert, hostError, mockHost, mountWorker, test, afterEach } from 'orca/testing'
import { deps } from './deps'
import * as main from './worker'

const originalDeps = { ...deps }
afterEach(() => {
  deps.run = originalDeps.run
  deps.fetch = originalDeps.fetch
})

function noTemper(): { runs: number; fetches: number } {
  const seen = { runs: 0, fetches: 0 }
  deps.run = async () => {
    seen.runs += 1
    return { code: 1, stdout: '', stderr: 'no temper here' }
  }
  deps.fetch = async () => {
    seen.fetches += 1
    return new Response('{}', { status: 500 })
  }
  return seen
}

test('a terminal is focused with its terminalId, and Orca\'s focused rides back', async () => {
  const seen = noTemper()
  const host = mockHost({ results: { 'terminal.focus': { focused: false } } })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.agent.focus', { workspaceId: 'ws-a', terminalId: 't-1' })

  assert.deepEqual(answer, { state: 'shown', via: 'terminal', focused: false })
  assert.deepEqual(host.callsOf('terminal.focus'), [{ terminalId: 't-1' }])
  assert.deepEqual(host.callsOf('workspace.open'), [])
  assert.deepEqual(seen, { runs: 0, fetches: 0 }, 'no temper read or write')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a chat, with no terminal, opens its workspace', async () => {
  noTemper()
  const host = mockHost({ results: { 'workspace.open': { opened: true } } })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.agent.focus', { workspaceId: 'ws-a', terminalId: null })

  assert.deepEqual(answer, { state: 'shown', via: 'workspace', focused: true })
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'ws-a' }])
  assert.deepEqual(host.callsOf('terminal.focus'), [])
  await worker.deactivate()
})

test('a refusal says what Orca said, with its code', async () => {
  noTemper()
  const host = mockHost({
    results: {
      'terminal.focus': () => {
        throw hostError('action_failed', 'no such terminal')
      }
    }
  })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.agent.focus', { workspaceId: 'ws-a', terminalId: 't-gone' })

  assert.equal(answer.state, 'refused')
  assert.equal(answer.state === 'refused' ? answer.code : null, 'action_failed')
  await worker.deactivate()
})

test('without workspace:write Orca refuses the focus, and the worker says so', async () => {
  noTemper()
  const host = mockHost({ capabilities: ['workspace:read', 'agent:read', 'storage:own'] })
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.agent.focus', { workspaceId: 'ws-a', terminalId: 't-1' })

  assert.equal(answer.state, 'refused')
  await worker.deactivate()
})

test('naming neither a terminal nor a workspace is the caller\'s error, before any Orca call', async () => {
  noTemper()
  const host = mockHost({})
  const worker = await mountWorker(main, { host })

  const answer = await worker.request('temper.agent.focus', { workspaceId: '', terminalId: null })

  assert.equal(answer.state, 'failed')
  assert.deepEqual(host.callsOf('workspace.open'), [])
  assert.deepEqual(host.callsOf('terminal.focus'), [])
  await worker.deactivate()
})
