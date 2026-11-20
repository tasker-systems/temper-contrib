// The witness for capability gating: with a consent withheld at the host — orca/testing's
// mockHost grants only the kinds it is handed, exactly as Orca holds a declined consent — the
// gated action draws disabled and names the missing consent in Orca's own words; with the
// consent granted, the action draws enabled and the press lands. "Start in a new workspace"
// (`workspace:create`) stands in for the actions the start and resume items will draw; the
// worker's pass-through of the host grant is witnessed in worker.test.ts.
import { assert, mockHost, mount, test, afterEach, type TestPanel } from 'orca/testing'
import type { OrcaNode } from 'orca'
import { consentSentence, GatedAction } from './capabilities'

let mounted: TestPanel | undefined
afterEach(() => {
  void mounted?.unmount()
  mounted = undefined
})

let pressed = 0

const GRANTED_HOST: readonly string[] = ['settings:own']

/** The representative gated action, lit by whatever the test hands it. */
function sample(granted: readonly string[]): () => OrcaNode {
  return () => (
    <GatedAction
      needs={['workspace:create']}
      granted={granted}
      label="Start in a new workspace"
      onPress={() => {
        pressed += 1
      }}
    />
  )
}

test('with the consent withheld, the action is disabled and names it', async () => {
  pressed = 0
  const host = mockHost({ capabilities: GRANTED_HOST })
  mounted = await mount(sample(GRANTED_HOST), { host })

  const button = mounted.find({ type: 'Button' })
  assert.equal(button?.props.disabled, true, 'the gated action draws disabled')
  assert.equal(button?.props.onPress, undefined, 'the dark action carries no way to fire')
  // The refusal is in Orca's own words, verbatim — workspace:create's approval-time
  // description on Orca 1.4.264.
  assert.ok(
    mounted.find({
      text: "Needs the 'Create workspaces (new Git branches and worktrees) in your projects, local and SSH; a project's setup script runs as its settings say' consent."
    }),
    "the refusal names the missing consent in Orca's own words"
  )
  assert.deepEqual(mounted.errors, [])
})

test('with the consent granted, the action is enabled and the press lands', async () => {
  pressed = 0
  const granted = ['settings:own', 'workspace:create']
  const host = mockHost({ capabilities: granted })
  mounted = await mount(sample(granted), { host })

  const button = mounted.find({ type: 'Button' })
  assert.notEqual(button?.props.disabled, true, 'the gated action draws enabled')
  assert.equal(
    mounted.find({
      text: "Needs the 'Create workspaces (new Git branches and worktrees) in your projects, local and SSH; a project's setup script runs as its settings say' consent."
    }),
    null,
    'no refusal is drawn for a granted consent'
  )
  await mounted.press({ type: 'Button' })
  assert.equal(pressed, 1, 'the lit action fires on press')
  assert.deepEqual(mounted.errors, [])
})

test('two withheld consents are named together', async () => {
  // The worker hands only what the host granted: agent:launch is withheld too.
  const granted = ['settings:own', 'workspace:create']
  const host = mockHost({ capabilities: granted })
  mounted = await mount(
    () => (
      <GatedAction
        needs={['workspace:create', 'workspace:read', 'agent:launch']}
        granted={granted}
        label="Start in a new workspace"
      />
    ),
    { host }
  )
  assert.ok(
    mounted.find({
      text: "Needs the 'Read your projects and workspaces (names, branches, paths and agent status) and the terminals in them, and get notified when they change' and 'Start and resume agents in your workspaces, local and SSH' consents."
    }),
    'both withheld consents are named together, in Orca\'s words'
  )
})

test('the consent sentence, in words, for one two and three', () => {
  assert.equal(
    consentSentence(['workspace:create']),
    "Needs the 'Create workspaces (new Git branches and worktrees) in your projects, local and SSH; a project's setup script runs as its settings say' consent."
  )
  assert.equal(
    consentSentence(['workspace:create', 'agent:launch']),
    "Needs the 'Create workspaces (new Git branches and worktrees) in your projects, local and SSH; a project's setup script runs as its settings say' and 'Start and resume agents in your workspaces, local and SSH' consents."
  )
  assert.equal(
    consentSentence(['a:b', 'c:d', 'e:f']),
    "Needs the 'a:b', 'c:d' and 'e:f' consents."
  )
})
