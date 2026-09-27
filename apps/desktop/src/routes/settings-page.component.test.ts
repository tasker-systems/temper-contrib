// The settings room's temper witnesses: the person's context name reads
// from the device store and saves back through it. `invoke` is mocked.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Page from './settings/+page.svelte';

// jsdom has no matchMedia; the theme control watches the system preference.
if (!window.matchMedia) {
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false
	})) as unknown as typeof window.matchMedia;
}

describe('the settings room', () => {
	beforeEach(() => {
		vi.mocked(invoke).mockImplementation((async (cmd: string) => {
			if (cmd === 'settings_get') {
				return Promise.resolve({ workingDir: '/w', temperContext: 'my-context' });
			}
			return Promise.resolve(null);
		}) as never);
	});

	it('reads the configured temper context from the store', async () => {
		const { container } = render(Page);
		await vi.waitFor(() => {
			const input = [...container.querySelectorAll('input')].at(-1) as HTMLInputElement;
			expect(input.value).toBe('my-context');
		});
	});

	it('saves a changed context name through the store', async () => {
		const { container } = render(Page);
		const input = await vi.waitFor(() => {
			const found = [...container.querySelectorAll('input')].at(-1) as HTMLInputElement;
			expect(found.value).toBe('my-context');
			return found;
		});
		await fireEvent.input(input, { target: { value: 'renamed-context' } });

		const saves = [...container.querySelectorAll('button')].filter(
			(b) => b.textContent === 'Save' || b.textContent === 'Saving…'
		);
		// The working directory's save is first; the temper context's is second.
		expect(saves.length).toBe(2);
		await fireEvent.click(saves[1]);

		await vi.waitFor(() =>
			expect(vi.mocked(invoke)).toHaveBeenCalledWith('settings_set_temper_context', {
				name: 'renamed-context'
			})
		);
	});
});
