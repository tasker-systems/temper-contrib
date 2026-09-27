import { render } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import RoomFrame from './RoomFrame.svelte';

/**
 * The room frame's witnesses (the room-frame plan, filed 2026-09-26): the way out is
 * two-sided — it renders in every room that has somewhere to go and never at the root,
 * where it would promise an exit that does not exist; an unfilled slot renders nothing,
 * never a placeholder claiming a state; and the frame stands in a room with no agent
 * engaged — the chrome is the building's, not the session's.
 */
const ROOMS = [
	{ href: '/', label: 'home' },
	{ href: '/settings', label: 'settings' }
];

const SETTINGS_ROOM = { title: 'settings', wayOut: { href: '/', label: 'home' } };

const reachSnippet = createRawSnippet(() => ({ render: () => '<span>words only</span>' }));

describe('RoomFrame', () => {
	it('renders the way out with where it goes, and first among the anchors', () => {
		const { container } = render(RoomFrame, { props: { rooms: ROOMS, room: SETTINGS_ROOM } });
		const wayOut = container.querySelector('a.t-way-out');
		expect(wayOut).not.toBeNull();
		expect(wayOut?.getAttribute('href')).toBe('/');
		expect(wayOut?.textContent).toContain('home');
		const anchors = container.querySelectorAll('header a');
		expect(anchors[0]).toBe(wayOut);
	});

	it('renders no way out at the root — an exit that cannot complete is a false affordance', () => {
		const { container } = render(RoomFrame, {
			props: { rooms: ROOMS, room: { title: 'home' } }
		});
		expect(container.querySelector('a.t-way-out')).toBeNull();
	});

	it('renders the declared room title and the bounded navigation', () => {
		const { container } = render(RoomFrame, { props: { rooms: ROOMS, room: SETTINGS_ROOM } });
		expect(container.querySelector('.t-room-title')?.textContent).toBe('settings');
		const links = [...container.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));
		expect(links).toEqual(['/', '/settings']);
	});

	it('renders nothing for an unfilled slot — no placeholder claiming a state', () => {
		const { container } = render(RoomFrame, { props: { rooms: ROOMS, room: SETTINGS_ROOM } });
		for (const slot of ['reach', 'pending', 'cacheAge', 'profile']) {
			expect(container.querySelector(`.t-slot-${slot}`)).toBeNull();
		}
	});

	it('renders a filled slot and leaves its unfilled siblings absent', () => {
		const { container } = render(RoomFrame, {
			props: { rooms: ROOMS, room: SETTINGS_ROOM, reach: reachSnippet }
		});
		expect(container.querySelector('.t-slot-reach')?.textContent).toContain('words only');
		expect(container.querySelector('.t-slot-pending')).toBeNull();
		expect(container.querySelector('.t-slot-cacheAge')).toBeNull();
		expect(container.querySelector('.t-slot-profile')).toBeNull();
	});

	it('renders a filled profile slot and leaves its unfilled siblings absent', () => {
		const { container } = render(RoomFrame, {
			props: { rooms: ROOMS, room: SETTINGS_ROOM, profile: reachSnippet }
		});
		expect(container.querySelector('.t-slot-profile')?.textContent).toContain('words only');
		expect(container.querySelector('.t-slot-reach')).toBeNull();
		expect(container.querySelector('.t-slot-pending')).toBeNull();
		expect(container.querySelector('.t-slot-cacheAge')).toBeNull();
	});

	it('survives a room with no agent engaged', () => {
		const { container } = render(RoomFrame, { props: { rooms: ROOMS, room: { title: 'home' } } });
		expect(container.querySelector('.t-room-title')?.textContent).toBe('home');
		expect(container.querySelectorAll('nav a').length).toBe(2);
		expect(container.querySelector('.t-slot-reach')).toBeNull();
		expect(container.querySelector('header')).not.toBeNull();
	});
});
