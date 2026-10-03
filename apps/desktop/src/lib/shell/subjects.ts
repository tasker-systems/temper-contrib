/**
 * What a tab holds: a subject, seen through a lens. A subject names a thing in temper's terms —
 * a resource, a query over what temper holds, a neighbourhood around a resource, or one of core's
 * own places — and never a file, a folder or a route.
 *
 * Links stay links. An in-app anchor names its subject by address (`/r/<ref>`, `/q?context=…`,
 * `/settings`), so it is a real, focusable link; the shell reads the address back into a subject
 * and opens it through the one door (`tabs.open`). The address carries only the target — where it
 * was followed from belongs to the tab's own trail.
 */
import { refId } from '$lib/document';

export type Place = 'home' | 'settings' | 'setup' | 'catalog' | 'new-resource';

export type Subject =
	| { kind: 'resource'; id: string }
	| { kind: 'query'; context?: string; docType?: string; text?: string }
	| { kind: 'neighbourhood'; id: string; depth: 1 }
	| { kind: 'presentation'; resource: string; artifact: string }
	/** `context`, where the place is about one — the create room is opened for a named context. */
	| { kind: 'place'; place: Place; context?: string };

const PLACES: readonly Place[] = ['home', 'settings', 'setup', 'catalog', 'new-resource'];

/** What a place is called before anything has been read about it — never its id. */
const PLACE_WORDS: Record<Place, string> = {
	home: 'home',
	settings: 'settings',
	setup: 'setup',
	catalog: 'catalog',
	'new-resource': 'new resource'
};

/** One stable key per subject: two subjects are the same subject exactly when their keys match. */
export function subjectKey(subject: Subject): string {
	switch (subject.kind) {
		case 'resource':
			return `resource:${subject.id}`;
		case 'neighbourhood':
			return `neighbourhood:${subject.id}:${subject.depth}`;
		case 'presentation':
			return `presentation:${subject.resource}:${subject.artifact}`;
		case 'place':
			return subject.context
				? `place:${subject.place}:${subject.context}`
				: `place:${subject.place}`;
		case 'query':
			return `query:${subject.context ?? ''}|${subject.docType ?? ''}|${subject.text ?? ''}`;
	}
}

/** What a subject is called before anything has been read about it — never a guess at a title. */
export function subjectWords(subject: Subject): string {
	switch (subject.kind) {
		case 'resource':
			return 'document';
		case 'neighbourhood':
			return 'neighbourhood';
		case 'presentation':
			return 'presented view';
		case 'place':
			return PLACE_WORDS[subject.place];
		case 'query':
			return (
				[subject.context, subject.docType, subject.text && `“${subject.text}”`]
					.filter(Boolean)
					.join(' · ') || 'query'
			);
	}
}

/** The address of a context, opened as a query over what it holds. */
export function contextHref(contextRef: string): string {
	return `/q?context=${encodeURIComponent(contextRef)}`;
}

/** The address of one of core's places. Home is the root; a context-riding place carries it. */
export function placeHref(place: Place, context?: string): string {
	if (place === 'home') return '/';
	return context ? `/${place}?context=${encodeURIComponent(context)}` : `/${place}`;
}

/**
 * The subject an in-app address names, or `null` when it names none — an address the shell does
 * not recognise is left to the browser, never guessed at.
 */
export function subjectFromAddress(pathname: string, search: URLSearchParams): Subject | null {
	if (pathname === '/') return { kind: 'place', place: 'home' };
	const room = pathname.match(/^\/r\/([^/]+)\/?$/);
	if (room) {
		const id = refId(decodeURIComponent(room[1]));
		return id ? { kind: 'resource', id } : null;
	}
	// A bare UUID as the whole path — an authored relative citation (`./<uuid>`)
	// resolved by the browser against the page — is entry by address, as ruled.
	// Only the exact 36-character form: anything looser is a guess.
	const bare = pathname.match(
		/^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i
	);
	if (bare) return { kind: 'resource', id: bare[1].toLowerCase() };
	if (pathname === '/q' || pathname === '/q/') {
		const query: Subject = { kind: 'query' };
		const context = search.get('context');
		const docType = search.get('docType');
		const text = search.get('text');
		if (context) query.context = context;
		if (docType) query.docType = docType;
		if (text) query.text = text;
		return context || docType || text ? query : null;
	}
	const place = pathname.replace(/^\/|\/$/g, '');
	if (place === 'new-resource') {
		// The create place names its target context in the address, as a query names its own.
		const subject: Subject = { kind: 'place', place: 'new-resource' };
		const context = search.get('context');
		if (context) subject.context = context;
		return subject;
	}
	return (PLACES as readonly string[]).includes(place)
		? { kind: 'place', place: place as Place }
		: null;
}

/** A subject read back from storage, or `null` when what was stored is not one. */
export function parseSubject(raw: unknown): Subject | null {
	if (!raw || typeof raw !== 'object') return null;
	const s = raw as Record<string, unknown>;
	const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
	switch (s.kind) {
		case 'resource':
			return str(s.id) ? { kind: 'resource', id: s.id } : null;
		case 'neighbourhood':
			return str(s.id) ? { kind: 'neighbourhood', id: s.id, depth: 1 } : null;
		case 'presentation':
			return str(s.resource) && str(s.artifact)
				? { kind: 'presentation', resource: s.resource, artifact: s.artifact }
				: null;
		case 'place': {
			if (!(PLACES as readonly unknown[]).includes(s.place)) return null;
			const restored: Subject = { kind: 'place', place: s.place as Place };
			// Only the create place names a context; a stray one on any other place is dropped.
			if (s.place === 'new-resource' && str(s.context)) restored.context = s.context;
			return restored;
		}
		case 'query': {
			const query: Subject = { kind: 'query' };
			if (str(s.context)) query.context = s.context;
			if (str(s.docType)) query.docType = s.docType;
			if (str(s.text)) query.text = s.text;
			return query.context || query.docType || query.text ? query : null;
		}
		default:
			return null;
	}
}
