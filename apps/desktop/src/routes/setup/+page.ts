import type { PageLoad } from './$types';

/** The setup room declares its identity and its way out: back to home, first in the frame. */
export const load: PageLoad = () => ({
	room: { title: 'setup', wayOut: { href: '/', label: 'home' } }
});
