// The setup room's witnesses: an unreachable temper refuses to save, a name
// missing from the person's own contexts warns and offers creation, a team-owned
// context of the same name never resolves, and a chosen name saves. `invoke` is
// mocked and records every call.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { temperViews } from '../lib/temper-views.svelte';
import Page from './setup/+page.svelte';

type CtxRow = {
	id: string;
	name: string;
	slug: string;
	ownerRef: string;
	resourceCount: number;
	updated: string;
};

let connected = true;
let contexts: CtxRow[] = [];
const saves: string[] = [];

function ownContext(name: string, slug = name): CtxRow {
	return {
		id: `id-${name}`,
		name,
		slug,
		ownerRef: '@pete',
		resourceCount: 0,
		updated: '2026-09-27T00:00:00Z'
	};
}

function routeInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
	switch (cmd) {
		case 'temper_connection_status':
			return Promise.resolve({
				connected,
				error: connected ? null : 'no credentials on this machine'
			});
		case 'temper_whoami':
			return Promise.resolve(connected ? { display_name: 'Pete Taylor', slug: 'pete' } : null);
		case 'temper_contexts':
			return Promise.resolve(contexts);
		case 'settings_get':
			return Promise.resolve({ workingDir: null, temperContext: null });
		case 'temper_context_create': {
			const name = args?.name as string;
			contexts = [...contexts, ownContext(name)];
			return Promise.resolve({
				id: `id-${name}`,
				name,
				slug: name,
				ownerRef: '@pete',
				updated: '2026-09-27T00:00:00Z'
			});
		}
		case 'settings_set_temper_context':
			saves.push(args?.name as string);
			return Promise.resolve(null);
		default:
			return Promise.resolve(null);
	}
}

function saveButton(container: HTMLElement): HTMLButtonElement | undefined {
	return [...container.querySelectorAll('button')].find(
		(b) => b.textContent === 'Save' || b.textContent === 'Saving…'
	);
}

describe('the setup room', () => {
	beforeEach(() => {
		connected = true;
		contexts = [];
		saves.length = 0;
		temperViews.reset();
		vi.mocked(invoke).mockImplementation(routeInvoke as never);
	});

	it('says temper is unreachable and refuses to save', async () => {
		connected = false;
		const { container } = render(Page);
		await vi.waitFor(() => expect(container.textContent).toContain('Temper unavailable'));
		expect(container.textContent).toContain('cannot be validated');
		const save = saveButton(container);
		expect(save?.disabled).toBe(true);
		expect(
			vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'settings_set_temper_context')
		).toBe(false);
	});

	it('warns on a missing name and offers creation — a team-owned context of the same name does not resolve', async () => {
		contexts = [{ ...ownContext('temper-desktop'), ownerRef: '+temper-dev' }];
		const { container } = render(Page);
		await vi.waitFor(() => expect(container.textContent).toContain('is not among your contexts'));
		const input = container.querySelector('input') as HTMLInputElement;
		expect(input.value).toBe('temper-desktop');
		expect(saveButton(container)?.disabled).toBe(true);
		expect(
			[...container.querySelectorAll('button')].some(
				(b) => b.textContent === 'create temper-desktop'
			)
		).toBe(true);
	});

	it('creates the context, then the name resolves and saves', async () => {
		const { container } = render(Page);
		await vi.waitFor(() => expect(container.textContent).toContain('no contexts of your own'));
		const create = [...container.querySelectorAll('button')].find(
			(b) => b.textContent === 'create temper-desktop'
		);
		expect(create).toBeDefined();
		await fireEvent.click(create as HTMLButtonElement);

		await vi.waitFor(() => expect(container.textContent).toContain('resolves'));
		expect(container.textContent).toContain('@pete/temper-desktop');
		expect(vi.mocked(invoke)).toHaveBeenCalledWith('temper_context_create', {
			name: 'temper-desktop'
		});

		const save = saveButton(container);
		expect(save?.disabled).toBe(false);
		await fireEvent.click(save as HTMLButtonElement);
		await vi.waitFor(() =>
			expect(vi.mocked(invoke)).toHaveBeenCalledWith('settings_set_temper_context', {
				name: 'temper-desktop'
			})
		);
	});

	it('saves a context chosen from the person’s own list', async () => {
		contexts = [ownContext('temper-desktop'), ownContext('notes')];
		const { container } = render(Page);
		await vi.waitFor(() => expect(container.textContent).toContain('notes'));

		const choice = [...container.querySelectorAll('button.choice')].find((b) =>
			b.textContent?.includes('notes')
		);
		await fireEvent.click(choice as HTMLButtonElement);

		const save = saveButton(container);
		expect(save?.disabled).toBe(false);
		await fireEvent.click(save as HTMLButtonElement);
		await vi.waitFor(() =>
			expect(vi.mocked(invoke)).toHaveBeenCalledWith('settings_set_temper_context', {
				name: 'notes'
			})
		);
	});

	it('saves nothing on its own — the room sits until the person acts', async () => {
		contexts = [ownContext('temper-desktop')];
		render(Page);
		await vi.waitFor(() => expect(temperViews.contexts).not.toBeNull());
		expect(saves).toEqual([]);
	});
});
