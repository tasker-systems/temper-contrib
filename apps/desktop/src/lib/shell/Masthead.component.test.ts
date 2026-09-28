import { render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import Masthead from './Masthead.svelte';

/**
 * The masthead's witnesses: it holds only what belongs to the window. An unfilled slot renders
 * nothing — never a placeholder claiming a state — and the masthead stands with no agent engaged:
 * the chrome is the building's, not the session's. A room's title and way out are the room
 * strip's, never the masthead's.
 */
const words = createRawSnippet(() => ({ render: () => '<span>words only</span>' }));

describe('the masthead', () => {
	it('links the wordmark home', () => {
		const { container } = render(Masthead);
		expect(container.querySelector('header a[href="/"]')?.textContent).toBe('temper');
	});

	it('renders nothing for an unfilled slot — no placeholder claiming a state', () => {
		const { container } = render(Masthead);
		expect(container.querySelector('.t-slot-profile')).toBeNull();
		expect(container.querySelector('.t-slot-agentToggle')).toBeNull();
	});

	it('renders a filled slot and leaves its unfilled sibling absent', () => {
		const { container } = render(Masthead, { props: { profile: words } });
		expect(container.querySelector('.t-slot-profile')?.textContent).toContain('words only');
		expect(container.querySelector('.t-slot-agentToggle')).toBeNull();
	});

	it('carries no room title and no way out — those belong to a step', () => {
		const { container } = render(Masthead);
		expect(container.querySelector('.t-room-title')).toBeNull();
		expect(container.querySelector('.t-way-out')).toBeNull();
		expect(container.querySelector('header')).not.toBeNull();
	});
});
