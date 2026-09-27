// The chrome menu's witnesses: it is closed until the person opens it — the
// app's only setup entry point never opens or navigates on its own — and its
// one entry reaches the setup room.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import RoomFrame from './RoomFrame.svelte';

function renderFrame() {
	return render(RoomFrame, { props: { rooms: [] } });
}

describe('the chrome menu', () => {
	it('is closed on render — nothing opens it on the app’s behalf', () => {
		const { container } = renderFrame();
		const trigger = container.querySelector('button.trigger');
		expect(trigger).not.toBeNull();
		expect(trigger?.getAttribute('aria-expanded')).toBe('false');
		expect(container.querySelector('a[href="/setup"]')).toBeNull();
	});

	it('reaches the setup room once opened', async () => {
		const { container } = renderFrame();
		const trigger = container.querySelector('button.trigger') as HTMLButtonElement;
		await fireEvent.click(trigger);
		const entry = container.querySelector('a[href="/setup"]');
		expect(entry).not.toBeNull();
		expect(entry?.textContent).toContain('app setup');
	});

	it('closes on Escape', async () => {
		const { container } = renderFrame();
		const trigger = container.querySelector('button.trigger') as HTMLButtonElement;
		await fireEvent.click(trigger);
		expect(container.querySelector('a[href="/setup"]')).not.toBeNull();
		await fireEvent.keyDown(document, { key: 'Escape' });
		expect(container.querySelector('a[href="/setup"]')).toBeNull();
	});
});
