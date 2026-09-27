// The home room's witnesses: the development probe is gone, the temper views
// stand in its place, a closed conversation writes its work record with
// the facts the page watched, and a permission ask renders the agent's own
// declared options and answers as the chosen one. `invoke` and `listen` are
// mocked and record every call.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { fireEvent, render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { temperViews } from '../lib/temper-views.svelte';
import Page from './+page.svelte';

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

async function startConversation(container: HTMLElement): Promise<void> {
	const input = container.querySelector('input');
	expect(input).not.toBeNull();
	await fireEvent.input(input as HTMLInputElement, { target: { value: '/tmp/project' } });
	const start = [...container.querySelectorAll('button')].find(
		(b) => b.textContent === 'Start conversation'
	);
	expect(start).toBeDefined();
	await fireEvent.click(start as HTMLButtonElement);
	await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'acp_start')).toBe(true));
	await vi.waitFor(() => expect(handlers['acp-ask']).toBeDefined());
}

describe('the home room', () => {
	beforeEach(() => {
		calls.length = 0;
		for (const key of Object.keys(handlers)) delete handlers[key];
		temperViews.reset();
		vi.mocked(invoke).mockImplementation(routeInvoke as never);
		vi.mocked(listen).mockImplementation(async (event, handler) => {
			handlers[event as string] = handler as (e: { payload: unknown }) => void;
			return () => {};
		});
	});

	it('renders no probe and no payload — the profile piece owns identity now', () => {
		const { container } = render(Page);
		expect(container.textContent).not.toContain('Who am I?');
		expect(container.querySelector('pre')).toBeNull();
	});

	it('renders the temper views', () => {
		const { container } = render(Page);
		const text = container.textContent ?? '';
		expect(text).toContain('Teams');
		expect(text).toContain('Contexts');
		expect(text).toContain('Recent work');
	});

	it('writes the work record when a conversation closes', async () => {
		const { container } = render(Page);
		await startConversation(container);

		const end = [...container.querySelectorAll('button')].find(
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
		expect(args.facts.agentCommand).toBe('opencode acp');
		expect(args.facts.workingDir).toBe('/tmp/project');
		expect(args.facts.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(args.facts.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(args.idempotencyKey).toBeTruthy();
	});

	it('stands as the conversation ask surface while the room is open', async () => {
		const { container } = render(Page);
		await startConversation(container);
		expect(
			calls.some(
				(c) =>
					c.cmd === 'acp_ask_surface' && c.args?.conversationId === 'c1' && c.args?.present === true
			)
		).toBe(true);

		const end = [...container.querySelectorAll('button')].find(
			(b) => b.textContent === 'End conversation'
		);
		await fireEvent.click(end as HTMLButtonElement);
		expect(
			calls.some(
				(c) =>
					c.cmd === 'acp_ask_surface' &&
					c.args?.conversationId === 'c1' &&
					c.args?.present === false
			)
		).toBe(true);
	});

	it('renders a permission ask with the agent’s declared options and answers as the chosen one', async () => {
		const { container } = render(Page);
		await startConversation(container);

		handlers['acp-ask']({ payload: declaredAsk });
		await vi.waitFor(() => expect(container.textContent).toContain('waiting for your answer'));
		expect(container.textContent).toContain('Write acp-ask-witness.txt');
		expect(container.textContent).toContain(JSON.stringify(declaredAsk.toolCall.rawInput, null, 2));
		for (const option of declaredAsk.options) {
			const button = [...container.querySelectorAll('button')].find((b) =>
				b.textContent?.includes(option.name)
			);
			expect(button, `the declared option ${option.name} should render`).toBeDefined();
			expect(button?.textContent).toContain(option.kind);
		}

		const allowOnce = [...container.querySelectorAll('button')].find((b) =>
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
			expect(container.textContent).toContain(
				'asked to Write acp-ask-witness.txt — answered: Allow once'
			)
		);
		expect(container.textContent).not.toContain('waiting for your answer');
	});

	it('records a cancelled ask in the transcript as no one was asked', async () => {
		const { container } = render(Page);
		await startConversation(container);

		handlers['acp-ask']({ payload: declaredAsk });
		await vi.waitFor(() => expect(container.textContent).toContain('waiting for your answer'));

		handlers['acp-ask']({
			payload: {
				kind: 'resolved',
				conversationId: 'c1',
				askId: 'ask-0',
				outcome: { outcome: 'cancelled' }
			}
		});
		await vi.waitFor(() =>
			expect(container.textContent).toContain(
				'asked to Write acp-ask-witness.txt — cancelled: no one was asked'
			)
		);
		expect(container.textContent).not.toContain('waiting for your answer');
	});
});
