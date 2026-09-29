// The chrome menu's witnesses: it is closed until the person opens it — the
// app's only setup entry point never opens on its own — and its entries reach
// settings, the setup place, and the ways-in panel.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { shellPanels } from '$lib/shell/panels.svelte';
import ChromeMenu from './ChromeMenu.svelte';

describe('the chrome menu', () => {
	it('is closed on render — nothing opens it on the app’s behalf', () => {
		const { container } = render(ChromeMenu);
		const trigger = container.querySelector('button.trigger');
		expect(trigger).not.toBeNull();
		expect(trigger?.getAttribute('aria-expanded')).toBe('false');
		expect(container.querySelector('a[href="/setup"]')).toBeNull();
	});

	it('reaches settings and the setup place once opened', async () => {
		const { container } = render(ChromeMenu);
		const trigger = container.querySelector('button.trigger') as HTMLButtonElement;
		await fireEvent.click(trigger);
		expect(container.querySelector('a[href="/settings"]')?.textContent).toContain('settings');
		expect(container.querySelector('a[href="/setup"]')?.textContent).toContain('app setup');
	});

	it('its ways-in entry opens the ways-in panel, and closes the menu', async () => {
		shellPanels.setWaysOpen(false);
		const { container } = render(ChromeMenu);
		const trigger = container.querySelector('button.trigger') as HTMLButtonElement;
		await fireEvent.click(trigger);
		expect(shellPanels.waysOpen).toBe(false);

		const entry = container.querySelector('.entry-action') as HTMLButtonElement;
		expect(entry?.textContent).toContain('ways in');
		await fireEvent.click(entry);
		expect(shellPanels.waysOpen).toBe(true);
		const stillOpen = container.querySelector('a[href="/settings"]');
		expect(stillOpen).toBeNull();
	});

	it('closes on Escape', async () => {
		const { container } = render(ChromeMenu);
		const trigger = container.querySelector('button.trigger') as HTMLButtonElement;
		await fireEvent.click(trigger);
		expect(container.querySelector('a[href="/setup"]')).not.toBeNull();
		await fireEvent.keyDown(document, { key: 'Escape' });
		expect(container.querySelector('a[href="/setup"]')).toBeNull();
	});
});
