// The slice-1 witness at its boundary: the engagement is the layout's, not
// the route's. Unmounting the route's page — what any room change does —
// leaves the transcript, a chunk streamed in between, and a parked ask
// intact, and the ask surface is never released.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSession } from '$lib/agent/session.svelte';
import Layout from './+layout.svelte';

type Call = { cmd: string; args: Record<string, unknown> | undefined };
const calls: Call[] = [];
const handlers: Record<string, (event: { payload: unknown }) => void> = {};

function routeInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
	calls.push({ cmd, args });
	if (cmd === 'acp_start') {
		return Promise.resolve({ conversationId: 'c1', sessionId: 's1', agentInfo: {} });
	}
	if (cmd === 'settings_get') {
		return Promise.resolve({
			workingDir: null,
			temperContext: null,
			agents: { opencode: { label: 'opencode', command: 'opencode acp' } }
		});
	}
	return Promise.resolve(null);
}

const declaredAsk = {
	kind: 'asked',
	conversationId: 'c1',
	askId: 'ask-0',
	toolCall: { toolCallId: 'call-1', title: 'Write witness.txt' },
	options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
};

describe('the layout owns the engagement', () => {
	beforeEach(() => {
		calls.length = 0;
		vi.mocked(invoke).mockImplementation(routeInvoke as never);
		vi.mocked(listen).mockImplementation(async (event, handler) => {
			handlers[event as string] = handler as (e: { payload: unknown }) => void;
			return () => {};
		});
		agentSession.conversation = null;
		agentSession.messages = [];
		agentSession.asks = [];
		agentSession.selection = { modes: null, configOptions: [] };
		// The roster is seeded, not loaded: `init()` is idempotent, so the
		// store's own read would be a first-test-only effect — these
		// witnesses test the engagement, not the roster read.
		agentSession.agents = [{ key: 'opencode', label: 'opencode', command: 'opencode acp' }];
		agentSession.agentKey = 'opencode';
		agentSession.prompting = false;
		agentSession.error = '';
		agentSession.init();
	});

	/** A conversation with a transcript line and a parked ask, as the panel left it. */
	async function startedConversationWithParkedAsk(): Promise<void> {
		agentSession.workingDir = '/tmp/project';
		await agentSession.start();
		handlers['acp-ask']({ payload: declaredAsk });
		handlers['acp-update']({
			payload: {
				conversationId: 'c1',
				sessionId: 's1',
				update: {
					sessionUpdate: 'agent_message_chunk',
					content: { type: 'text', text: 'working…' }
				}
			}
		});
		await vi.waitFor(() => expect(agentSession.asks).toHaveLength(1));
	}

	it('unmounting the layout keeps the engagement, and a fresh mount restores it without re-starting', async () => {
		const first = render(Layout, { props: { children: undefined } });
		await startedConversationWithParkedAsk();

		// The store outlives the component: the transcript, the streamed
		// chunk and the parked ask are all still there after the layout is
		// gone. Full teardown legitimately releases the ask surface (the
		// app window closed); the engagement itself was never closed.
		first.unmount();
		expect(agentSession.conversation?.conversationId).toBe('c1');
		expect(agentSession.messages.map((m) => m.text)).toContain('working…');
		expect(agentSession.asks).toHaveLength(1);
		expect(calls.some((c) => c.cmd === 'acp_close')).toBe(false);

		// A fresh mount draws the same conversation from the store and
		// re-claims the ask surface: `acp_start` is not called again.
		calls.length = 0;
		render(Layout, { props: { children: undefined } });
		await vi.waitFor(() =>
			expect(calls.some((c) => c.cmd === 'acp_ask_surface' && c.args?.present === true)).toBe(true)
		);
		expect(calls.some((c) => c.cmd === 'acp_start')).toBe(false);
		expect(agentSession.messages.map((m) => m.text)).toContain('working…');
		expect(agentSession.asks).toHaveLength(1);
	});

	it('the toggle shows the pending count while the panel is closed', async () => {
		const { container } = render(Layout, { props: { children: undefined } });
		await startedConversationWithParkedAsk();
		agentSession.setPanelOpen(false);
		await vi.waitFor(() => expect(container.querySelector('.agent-toggle')).not.toBeNull());
		expect(container.querySelector('.agent-toggle')?.textContent).toContain('◇ 1');
		expect(container.querySelector('.agent-toggle')?.getAttribute('aria-label')).toContain(
			'awaiting your answer'
		);
	});

	it('the reach line reads the same words from the layout, panel closed or open', () => {
		agentSession.conversation = {
			conversationId: 'c1',
			sessionId: 's1',
			agentInfo: {}
		};
		const { container } = render(Layout, { props: { children: undefined } });
		const reach = container.querySelector('.t-slot-reach');
		expect(reach?.textContent).toContain('the desktop relays what it asks');
	});
});
