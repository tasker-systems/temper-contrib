// The home room's witnesses: the development probe is gone, the temper views
// stand in its place, and a closed conversation writes its work record with
// the facts the page watched. `invoke` is mocked and records every call.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { temperViews } from '../lib/temper-views.svelte';
import Page from './+page.svelte';

type Call = { cmd: string; args: Record<string, unknown> | undefined };
const calls: Call[] = [];

function routeInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
	calls.push({ cmd, args });
	if (cmd === 'acp_start') {
		return Promise.resolve({ conversationId: 'c1', sessionId: 's1', agentInfo: {} });
	}
	if (cmd === 'settings_get') return Promise.resolve({ workingDir: null, temperContext: null });
	return Promise.resolve(null);
}

describe('the home room', () => {
	beforeEach(() => {
		calls.length = 0;
		temperViews.reset();
		vi.mocked(invoke).mockImplementation(routeInvoke as never);
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
		const input = container.querySelector('input');
		expect(input).not.toBeNull();
		await fireEvent.input(input as HTMLInputElement, { target: { value: '/tmp/project' } });

		const start = [...container.querySelectorAll('button')].find(
			(b) => b.textContent === 'Start conversation'
		);
		expect(start).toBeDefined();
		await fireEvent.click(start as HTMLButtonElement);
		await vi.waitFor(() => expect(calls.some((c) => c.cmd === 'acp_start')).toBe(true));

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
});
