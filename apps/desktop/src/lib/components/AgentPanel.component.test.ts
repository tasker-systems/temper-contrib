// The agent panel's witnesses: the engagement is the store's, not the
// route's — a conversation started in the panel keeps its transcript and
// asks, the ask surface is claimed by the layout while a conversation
// lives, and a closed panel is a hidden view, not a lost conversation.
// `invoke` and `listen` are mocked and record every call.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { fireEvent, render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSession } from '$lib/agent/session.svelte';
import AgentPanel from './AgentPanel.svelte';

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
	toolCall: {
		toolCallId: 'call-1',
		title: 'Write acp-ask-witness.txt',
		rawInput: { file_path: '/tmp/project/acp-ask-witness.txt', content: 'OK' }
	},
	options: [
		{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
		{ optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
		{ optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
	]
};

async function startConversation(): Promise<void> {
	const input = document.querySelector('input');
	expect(input).not.toBeNull();
	await fireEvent.input(input as HTMLInputElement, { target: { value: '/tmp/project' } });
	const start = [...document.querySelectorAll('button')].find(
		(b) => b.textContent === 'Start conversation'
	);
	expect(start).toBeDefined();
	await fireEvent.click(start as HTMLButtonElement);
	await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'acp_start')).toBe(true));
	await vi.waitFor(() => expect(handlers['acp-ask']).toBeDefined());
}

describe('the agent panel', () => {
	beforeEach(() => {
		calls.length = 0;
		vi.mocked(invoke).mockImplementation(routeInvoke as never);
		vi.mocked(listen).mockImplementation(async (event, handler) => {
			handlers[event as string] = handler as (e: { payload: unknown }) => void;
			return () => {};
		});
		// The layout owns init(); the panel test needs the listeners it
		// registers. Idempotent, so calling it here too is safe.
		agentSession.init();
		agentSession.conversation = null;
		agentSession.messages = [];
		agentSession.asks = [];
		agentSession.presentations = [];
		agentSession.prompting = false;
		agentSession.error = '';
	});

	it('starts a conversation and writes the work record when it closes', async () => {
		render(AgentPanel);
		await startConversation();

		const end = [...document.querySelectorAll('button')].find(
			(b) => b.textContent === 'End conversation'
		);
		expect(end).toBeDefined();
		await fireEvent.click(end as HTMLButtonElement);

		const record = calls.find((c) => c.cmd === 'temper_write_work_record');
		expect(record).toBeDefined();
		const args = record?.args as {
			facts: Record<string, string>;
			idempotencyKey: string;
		};
		expect(args.facts.agentLabel).toBe('opencode');
		expect(args.facts.workingDir).toBe('/tmp/project');
		expect(args.facts.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(args.facts.closedAt).toMatch(/^\d{2}-\d{2}T|^\d{4}-\d{2}-\d{2}T/);
		expect(args.idempotencyKey).toBeTruthy();
	});

	it('renders a permission ask with the agent’s declared options and answers as the chosen one', async () => {
		render(AgentPanel);
		await startConversation();

		handlers['acp-ask']({ payload: declaredAsk });
		await vi.waitFor(() => expect(document.body.textContent).toContain('waiting for your answer'));
		expect(document.body.textContent).toContain('Write acp-ask-witness.txt');
		for (const option of declaredAsk.options) {
			const button = [...document.querySelectorAll('button')].find((b) =>
				b.textContent?.includes(option.name)
			);
			expect(button, `the declared option ${option.name} should render`).toBeDefined();
			expect(button?.textContent).toContain(option.kind);
		}

		const allowOnce = [...document.querySelectorAll('button')].find((b) =>
			b.textContent?.includes('Allow once')
		);
		await fireEvent.click(allowOnce as HTMLButtonElement);
		expect(
			calls.some(
				(c) =>
					c.cmd === 'acp_answer_permission' &&
					c.args?.conversationId === 'c1' &&
					c.args?.askId === 'ask-0' &&
					c.args?.optionId === 'allow-once'
			)
		).toBe(true);

		handlers['acp-ask']({
			payload: {
				kind: 'resolved',
				conversationId: 'c1',
				askId: 'ask-0',
				outcome: { outcome: 'selected', optionId: 'allow-once' }
			}
		});
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain(
				'asked to Write acp-ask-witness.txt — answered: Allow once'
			)
		);
		expect(document.body.textContent).not.toContain('waiting for your answer');
	});

	it('records a cancelled ask in the transcript as no one was asked', async () => {
		render(AgentPanel);
		await startConversation();

		handlers['acp-ask']({ payload: declaredAsk });
		await vi.waitFor(() => expect(document.body.textContent).toContain('waiting for your answer'));

		handlers['acp-ask']({
			payload: {
				kind: 'resolved',
				conversationId: 'c1',
				askId: 'ask-0',
				outcome: { outcome: 'cancelled' }
			}
		});
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain(
				'asked to Write acp-ask-witness.txt — cancelled: no one was asked'
			)
		);
		expect(document.body.textContent).not.toContain('waiting for your answer');
	});

	it('checks a presented view the moment it arrives, shows it pending, and clears it on its end', async () => {
		render(AgentPanel);
		await startConversation();
		await vi.waitFor(() => expect(handlers['acp-present']).toBeDefined());

		const conforming = {
			root: 'r',
			elements: {
				r: { type: 'RegionState', props: { state: 'failed', label: 'history' }, children: [] }
			}
		};
		handlers['acp-present']({
			payload: {
				kind: 'presented',
				conversationId: 'c1',
				presentedId: 'presented-0',
				agent: 'opencode',
				spec: conforming
			}
		});
		const section = await vi.waitFor(() => {
			const s = document.querySelector('section[aria-label="View presented"]');
			expect(s).not.toBeNull();
			return s as HTMLElement;
		});
		expect(section.getAttribute('aria-busy')).toBe('true');
		expect(section.textContent).toContain('opencode presented a view');
		await vi.waitFor(() =>
			expect(
				calls.some(
					(c) =>
						c.cmd === 'present_answer' &&
						c.args?.presentedId === 'presented-0' &&
						c.args?.rendered === true
				)
			).toBe(true)
		);

		handlers['acp-present']({
			payload: {
				kind: 'resolved',
				conversationId: 'c1',
				presentedId: 'presented-0',
				outcome: { ok: 'rendered' }
			}
		});
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain('presented a view — checked and rendered')
		);
		expect(document.querySelector('section[aria-label="View presented"]')).toBeNull();
	});

	it('answers a non-conforming view refused with checkSpec’s reasons', async () => {
		render(AgentPanel);
		await startConversation();
		await vi.waitFor(() => expect(handlers['acp-present']).toBeDefined());

		handlers['acp-present']({
			payload: {
				kind: 'presented',
				conversationId: 'c1',
				presentedId: 'presented-1',
				agent: 'opencode',
				spec: {
					root: 'r',
					elements: {
						r: {
							type: 'RegionState',
							props: { state: 'failed', label: 'history', colour: 'red' },
							children: []
						}
					}
				}
			}
		});
		const answered = await vi.waitFor(() => {
			const call = calls.find((c) => c.cmd === 'present_answer');
			expect(call).toBeDefined();
			return call?.args as { rendered: boolean; reasons: string[] };
		});
		expect(answered.rendered).toBe(false);
		expect(answered.reasons.some((r) => r.includes('colour'))).toBe(true);
	});

	it('closing the panel hides the view and keeps the conversation', async () => {
		const { container } = render(AgentPanel);
		await startConversation();
		expect(document.body.textContent).toContain('session');

		const close = [...container.querySelectorAll('button')].find(
			(b) => b.getAttribute('aria-label') === 'Close the agent panel'
		);
		await fireEvent.click(close as HTMLButtonElement);

		// The conversation survives the closed panel: only the view is hidden.
		expect(agentSession.conversation?.conversationId).toBe('c1');
		expect(agentSession.panelOpen).toBe(false);
		const persisted = calls.find((c) => c.cmd === 'acp_ask_surface');
		// No ask-surface call was made by the panel itself.
		expect(persisted).toBeUndefined();
	});

	it('the panel expands for the work and returns, and the choice persists', async () => {
		const { container } = render(AgentPanel);
		const aside = container.querySelector('aside[aria-label="Agent"]') as HTMLElement;
		const expand = () =>
			[...container.querySelectorAll('button')].find(
				(b) => b.getAttribute('aria-label') === 'Expand the agent panel for more room'
			) as HTMLButtonElement;
		const narrow = () =>
			[...container.querySelectorAll('button')].find(
				(b) => b.getAttribute('aria-label') === 'Return the agent panel to its usual width'
			) as HTMLButtonElement;

		expect(agentSession.expanded).toBe(false);
		expect(expand()).toBeDefined();
		await fireEvent.click(expand());
		expect(agentSession.expanded).toBe(true);
		expect(aside.className).toContain('expanded');
		expect(aside.getAttribute('aria-label')).toBe('Agent');

		await fireEvent.click(narrow());
		expect(agentSession.expanded).toBe(false);
		expect(aside.className).not.toContain('expanded');

		// The choice is a device fact — setExpanded persisted it, restorePanel reads it back.
		expect(localStorage.getItem('temper-agent-panel-expanded-v1')).toBe(JSON.stringify(false));
	});

	// The settings room rewrites the roster and the core says so; the store
	// re-reads on the event, so the panel's picker follows without a rebuild.
	// Before the event existed, a save or removal in the settings room left the
	// panel stale until the app restarted — this witness bites on exactly that.
	it('the picker follows the roster when the settings room changes it', async () => {
		render(AgentPanel);
		await vi.waitFor(() =>
			expect(
				[...document.querySelectorAll('[aria-label="Agent"] button')].map((b) => b.textContent)
			).toContain('opencode')
		);
		expect(
			[...document.querySelectorAll('[aria-label="Agent"] button')].map((b) => b.textContent)
		).not.toContain('gemini');

		// The settings room saves gemini; the store's answer now carries it.
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === 'settings_get') {
				return Promise.resolve({
					workingDir: null,
					temperContext: null,
					agents: {
						opencode: { label: 'opencode', command: 'opencode acp' },
						gemini: { label: 'Gemini CLI', command: 'gemini --acp' }
					}
				});
			}
			return Promise.resolve(null);
		}) as never);
		const fire = handlers['device-roster-changed'];
		expect(fire).toBeDefined();
		fire({ payload: {} });

		await vi.waitFor(() =>
			expect(
				[...document.querySelectorAll('[aria-label="Agent"] button')].map((b) => b.textContent)
			).toContain('Gemini CLI')
		);
	});
});
