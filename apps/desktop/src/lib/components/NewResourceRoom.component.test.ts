// The create room's witnesses: a task create sends the context, the type and the
// title — and no metadata save, a task carries no defaults; a session create saves
// its `date` default through the metadata door after the create lands, then opens;
// a refusal is one line, opens nothing, and leaves the form standing for an
// immediate retry; a context temper does not answer creates nothing and says so.
// `invoke` is mocked and records every call.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabHandle } from '$lib/shell/lenses';
import { temperViews } from '$lib/temper-views.svelte';
import Page from './NewResourceRoom.svelte';

const NOTES = {
	id: 'ctx-1',
	name: 'notes',
	slug: 'notes',
	ownerRef: '@pete',
	resourceCount: 3,
	updated: '2026-10-01T00:00:00Z'
};
const NEW = '01a0f100-0000-7000-8000-000000000001';

let contexts: unknown[];
let createAnswer: unknown;
/** What the room opened through the tab handle, in order. */
const opens: { subject: unknown; where: string }[] = [];
const tab = {
	setTitle: () => {},
	open: (subject: unknown, where = 'here') => opens.push({ subject, where }),
	beforeLeave: () => () => {}
} as unknown as TabHandle;

function routeInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
	switch (cmd) {
		case 'temper_contexts':
			return Promise.resolve(contexts);
		case 'doc_create':
			return Promise.resolve(
				createAnswer ?? {
					state: 'created',
					id: NEW,
					decoratedRef: `a-resource-${NEW}`,
					title: args?.title as string
				}
			);
		case 'doc_save_meta':
			return Promise.resolve({ state: 'saved' });
		default:
			return Promise.resolve(null);
	}
}

/** The create-time date, in this device's days — the same words the room asks with. */
const today = (): string => {
	const now = new Date();
	const month = `${now.getMonth() + 1}`.padStart(2, '0');
	const day = `${now.getDate()}`.padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
};

async function fillAndSubmit(
	container: HTMLElement,
	title: string,
	doctype?: string
): Promise<void> {
	if (doctype) {
		const select = container.querySelector('select') as HTMLSelectElement;
		await fireEvent.change(select, { target: { value: doctype } });
	}
	const input = container.querySelector('input') as HTMLInputElement;
	await fireEvent.input(input, { target: { value: title } });
	const create = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Create');
	await fireEvent.click(create as HTMLButtonElement);
}

describe('the create room', () => {
	beforeEach(() => {
		contexts = [NOTES];
		createAnswer = null;
		opens.length = 0;
		temperViews.reset();
		vi.mocked(invoke).mockClear();
		vi.mocked(invoke).mockImplementation(routeInvoke as never);
	});

	it('creating a task sends the context, the type and the title — and no metadata save', async () => {
		const { container } = render(Page, { props: { tab, context: '@pete/notes' } });
		await vi.waitFor(() => expect(container.textContent).toContain('notes — @pete/notes'));
		await fillAndSubmit(container, 'Write the witness');
		await vi.waitFor(() => expect(opens).toHaveLength(1));
		expect(vi.mocked(invoke)).toHaveBeenCalledWith('doc_create', {
			contextId: 'ctx-1',
			docType: 'task',
			title: 'Write the witness'
		});
		expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'doc_save_meta')).toBe(false);
		expect(opens).toEqual([{ subject: { kind: 'resource', id: NEW }, where: 'here' }]);
	});

	it('creating a session saves its date default after the create, then opens it', async () => {
		const { container } = render(Page, { props: { tab, context: '@pete/notes' } });
		await vi.waitFor(() => expect(container.textContent).toContain('notes — @pete/notes'));
		await fillAndSubmit(container, 'A morning session', 'session');
		await vi.waitFor(() => expect(opens).toHaveLength(1));
		const cmds = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
		expect(cmds.indexOf('doc_create')).toBeLessThan(cmds.indexOf('doc_save_meta'));
		expect(vi.mocked(invoke)).toHaveBeenCalledWith('doc_save_meta', {
			id: NEW,
			patch: { openMeta: { date: today() } }
		});
	});

	it('a refusal is one line, opens nothing, and the form stands for an immediate retry', async () => {
		createAnswer = { state: 'refused', reason: 'forbidden', idempotencyKey: NEW };
		const { container } = render(Page, { props: { tab, context: '@pete/notes' } });
		await vi.waitFor(() => expect(container.textContent).toContain('notes — @pete/notes'));
		await fillAndSubmit(container, 'Write the witness');
		await vi.waitFor(() =>
			expect(container.querySelector('[role="alert"]')?.textContent).toContain('forbidden')
		);
		expect(opens).toEqual([]);
		expect((container.querySelector('input') as HTMLInputElement).value).toBe('Write the witness');
		// An immediate retry resends the create — the room kept everything it was given.
		await fireEvent.click(
			[...container.querySelectorAll('button')].find(
				(b) => b.textContent === 'Create'
			) as HTMLButtonElement
		);
		await vi.waitFor(() =>
			expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'doc_create')).toHaveLength(2)
		);
	});

	it('a context temper does not answer creates nothing and says so', async () => {
		const { container } = render(Page, { props: { tab, context: '@pete/elsewhere' } });
		await vi.waitFor(() =>
			expect(container.textContent).toContain('is not among the contexts temper answers')
		);
		const create = [...container.querySelectorAll('button')].find(
			(b) => b.textContent === 'Create'
		);
		expect(create?.disabled).toBe(true);
	});
});
