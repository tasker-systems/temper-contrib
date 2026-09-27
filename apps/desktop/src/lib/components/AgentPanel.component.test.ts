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
	if (cmd === 'settings_get') return Promise.resolve({ workingDir: null, temperContext: null });
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
});
