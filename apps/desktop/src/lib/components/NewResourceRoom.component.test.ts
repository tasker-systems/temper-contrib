// The create room's witnesses: a task create sends the context, the type and the
// title — and no metadata save, a task carries no defaults; a session create saves
// its `date` default through the metadata door after the create lands, then opens;
// a refusal is one line, opens nothing, and leaves the form standing for an
// immediate retry; a refused create is retried with its retained idempotency key
// (even with the fields edited) and a landing ends the room's create story; a
// failure after the landing still opens the tab, says created, and never re-invites
// the create; a converged retry whose type changed skips the defaults stamp and
// says so; creates validate only against this session's reads. `invoke` is mocked
// and records every call.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shellContributions } from '$lib/shell/contributions';
import { pluginPackages } from '$lib/shell/contributions/plugin-fixture';
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
		case 'plugin_packages':
			return Promise.resolve(pluginPackages());
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
	beforeEach(async () => {
		contexts = [NOTES];
		createAnswer = null;
		opens.length = 0;
		temperViews.reset();
		vi.mocked(invoke).mockClear();
		vi.mocked(invoke).mockImplementation(routeInvoke as never);
		shellContributions.init();
		await vi.waitFor(() => expect(shellContributions.ready).toBe(true));
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
		// After a landed create the caches re-read, so the resource is there when
		// looked for — the recent list and every enabled list of resources.
		expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'temper_recent_work')).toBe(true);
		expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'temper_list_resources')).toBe(
			true
		);
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

	it('a refused create is retried with its key, and the landing ends the room’s create story', async () => {
		createAnswer = { state: 'refused', reason: 'forbidden', idempotencyKey: NEW };
		const { container } = render(Page, { props: { tab, context: '@pete/notes' } });
		await vi.waitFor(() => expect(container.textContent).toContain('notes — @pete/notes'));
		await fillAndSubmit(container, 'Write the witness');
		await vi.waitFor(() =>
			expect(container.querySelector('[role="alert"]')?.textContent).toContain('forbidden')
		);
		// The person edits the title and presses Create again — the retained key rides
		// along: the server dedups on owner and key, and converging is the desired outcome.
		await fillAndSubmit(container, 'Write the witness, revised');
		await vi.waitFor(() =>
			expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'doc_create')).toHaveLength(2)
		);
		const [, retryArgs] = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'doc_create')[1];
		expect(retryArgs).toEqual({
			contextId: 'ctx-1',
			docType: 'task',
			title: 'Write the witness, revised',
			idempotencyKey: NEW
		});
		// The retry lands: the create that converges is the one carrying the key.
		createAnswer = null;
		await fillAndSubmit(container, 'Write the witness, revised');
		await vi.waitFor(() =>
			expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'doc_create')).toHaveLength(3)
		);
		const [, landedArgs] = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'doc_create')[2];
		expect(landedArgs).toEqual({
			contextId: 'ctx-1',
			docType: 'task',
			title: 'Write the witness, revised',
			idempotencyKey: NEW
		});
		await vi.waitFor(() => expect(opens).toHaveLength(1));
		// The landing ends this room's create story: the form is done, Create is gone,
		// and no second create is invitable from it — the key it spent is not reachable
		// again, and a next create mints afresh from a room opened anew.
		expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Create')).toBe(
			false
		);
		expect(container.querySelector('input')).toBeNull();
		expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'doc_create')).toHaveLength(3);
	});

	it('a failed create renders its line, opens nothing, and a retry resends its key', async () => {
		createAnswer = {
			state: 'failed',
			message: 'the connection was refused',
			idempotencyKey: NEW
		};
		const { container } = render(Page, { props: { tab, context: '@pete/notes' } });
		await vi.waitFor(() => expect(container.textContent).toContain('notes — @pete/notes'));
		await fillAndSubmit(container, 'Write the witness');
		await vi.waitFor(() =>
			expect(container.querySelector('[role="alert"]')?.textContent).toContain(
				'the connection was refused'
			)
		);
		expect(opens).toEqual([]);
		// The failed arm carries its key too: the retry converges instead of duplicating.
		await fireEvent.click(
			[...container.querySelectorAll('button')].find(
				(b) => b.textContent === 'Create'
			) as HTMLButtonElement
		);
		await vi.waitFor(() =>
			expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'doc_create')).toHaveLength(2)
		);
		const [, retryArgs] = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'doc_create')[1];
		expect(retryArgs).toMatchObject({ idempotencyKey: NEW });
	});

	it('a failure after the create lands still opens the tab, says created, and never re-invites the create', async () => {
		const { container } = render(Page, { props: { tab, context: '@pete/notes' } });
		await vi.waitFor(() => expect(container.textContent).toContain('notes — @pete/notes'));
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === 'doc_save_meta') return Promise.reject(new Error('the metadata door jammed'));
			return routeInvoke(cmd);
		}) as never);
		await fillAndSubmit(container, 'A morning session', 'session');
		// The landing stands: the tab opens on the created resource all the same.
		await vi.waitFor(() =>
			expect(opens).toEqual([{ subject: { kind: 'resource', id: NEW }, where: 'here' }])
		);
		// One honest line — created, with what failed to ride along — never "Not created".
		expect(container.textContent).toContain('Created');
		expect(container.textContent).toContain('the metadata door jammed');
		expect(container.textContent).not.toContain('Not created');
		// The form is done: no second create is invitable.
		expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Create')).toBe(
			false
		);
	});

	it('a defaults save answering failed leaves the landing standing — the tab still opens', async () => {
		const { container } = render(Page, { props: { tab, context: '@pete/notes' } });
		await vi.waitFor(() => expect(container.textContent).toContain('notes — @pete/notes'));
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === 'doc_save_meta') {
				return Promise.resolve({ state: 'failed', message: 'the write did not complete' });
			}
			return routeInvoke(cmd);
		}) as never);
		await fillAndSubmit(container, 'A morning session', 'session');
		await vi.waitFor(() =>
			expect(opens).toEqual([{ subject: { kind: 'resource', id: NEW }, where: 'here' }])
		);
		expect(container.textContent).toContain('the write did not complete');
	});

	it('a converged retry whose type changed skips the defaults stamp and says so', async () => {
		const { container } = render(Page, { props: { tab, context: '@pete/notes' } });
		await vi.waitFor(() => expect(container.textContent).toContain('notes — @pete/notes'));
		createAnswer = { state: 'refused', reason: 'forbidden', idempotencyKey: NEW };
		await fillAndSubmit(container, 'Write the witness');
		await vi.waitFor(() =>
			expect(container.querySelector('[role="alert"]')?.textContent).toContain('forbidden')
		);
		// The person re-chooses the type and presses Create: the retained key converges on
		// the earlier-committed task, and the session defaults would stamp one vocabulary's
		// metadata over another's — the stamp is skipped, and the skip says so.
		createAnswer = null;
		await fillAndSubmit(container, 'Write the witness', 'session');
		await vi.waitFor(() =>
			expect(opens).toEqual([{ subject: { kind: 'resource', id: NEW }, where: 'here' }])
		);
		expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'doc_save_meta')).toBe(false);
		expect(container.textContent).toContain('Created');
		expect(container.textContent).toContain('task');
	});

	it('creates only on this session’s reads — a cache a failed re-read left behind never enables Create', async () => {
		// Warm the store the way a previous session's cache would.
		contexts = [NOTES];
		await temperViews.refreshContexts();
		expect(temperViews.contextsFresh).toBe(true);
		// This session's re-read fails; the cache survives it, labeled stale.
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === 'temper_contexts') return Promise.reject(new Error('read failed'));
			return routeInvoke(cmd);
		}) as never);
		const { container } = render(Page, { props: { tab, context: '@pete/notes' } });
		await vi.waitFor(() =>
			expect(container.querySelector('[role="alert"]')?.textContent).toContain('read failed')
		);
		const input = container.querySelector('input') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'Write the witness' } });
		const create = [...container.querySelectorAll('button')].find(
			(b) => b.textContent === 'Create'
		);
		expect(create?.disabled).toBe(true);
		expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'doc_create')).toBe(false);
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
