import { parseWalk, wayOutOf } from '$lib/document';
import type { PageLoad } from './$types';

/**
 * The document room declares its identity and its way out, and reads nothing: every read belongs
 * to the room itself, so a failed read never blocks the route and hovering a link reads nothing.
 * The title reads `document` until the room has read what temper calls it — never a guess.
 */
export const load: PageLoad = ({ params, url }) => {
	const walk = parseWalk(url.searchParams.get('walk'));
	return {
		ident: params.ident,
		walk,
		room: { title: 'document', wayOut: wayOutOf(walk) }
	};
};
