import type { PageLoad } from './$types';

/** The settings room declares its identity and its way out: back to home, first in the frame. */
export const load: PageLoad = () => ({
	room: { title: 'settings', wayOut: { href: '/', label: 'home' } }
});
