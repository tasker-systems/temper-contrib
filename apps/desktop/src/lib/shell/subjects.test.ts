import { describe, expect, it } from 'vitest';
import { roomHref as resourceHref } from '$lib/document';
import {
	contextHref,
	parseSubject,
	placeHref,
	subjectFromAddress,
	subjectKey,
	subjectWords
} from './subjects';

const ID = '01a0e020-a6d7-7420-b924-68f5e89f354b';
const at = (href: string) => {
	const url = new URL(href, 'http://tauri.localhost');
	return subjectFromAddress(url.pathname, url.searchParams);
};

describe('reading an address back into a subject', () => {
	it('reads a resource by bare or decorated reference', () => {
		expect(at(resourceHref(ID))).toEqual({ kind: 'resource', id: ID });
		expect(at(resourceHref(`build-the-document-room-${ID}`))).toEqual({ kind: 'resource', id: ID });
	});

	it('reads a context as a query, and a place by name', () => {
		expect(at(contextHref('+temper-dev/contrib'))).toEqual({
			kind: 'query',
			context: '+temper-dev/contrib'
		});
		expect(at('/')).toEqual({ kind: 'place', place: 'home' });
		expect(at('/settings')).toEqual({ kind: 'place', place: 'settings' });
	});

	it('reads a bare-UUID path as entry by address — the authored relative citation', () => {
		expect(at(`/${ID}`)).toEqual({ kind: 'resource', id: ID });
		expect(at(`/${ID}/`)).toEqual({ kind: 'resource', id: ID });
		const slugUuid = `build-the-document-room-${ID}`;
		// A decorated or slug-bearing path is NOT bare: no guessing.
		expect(at(`/${slugUuid}`)).toBeNull();
		expect(at('/abc')).toBeNull();
		expect(at('/01a0e8eb-75b0-71c3-b788')).toBeNull();
	});

	it('leaves an address it does not recognise alone', () => {
		expect(at('/r/not-a-reference')).toBeNull();
		expect(at('/q')).toBeNull();
		expect(at('/elsewhere')).toBeNull();
	});

	it('keys a subject by what it is, whatever address named it', () => {
		const a = at(resourceHref(ID));
		const b = at(resourceHref(`some-slug-${ID}`));
		expect(a && b && subjectKey(a) === subjectKey(b)).toBe(true);
	});
});

describe('the create place', () => {
	it('reads the new-resource place, the context riding the address', () => {
		expect(at('/new-resource?context=%2Bpete%2Fnotes')).toEqual({
			kind: 'place',
			place: 'new-resource',
			context: '+pete/notes'
		});
		// Without a context the place still resolves — the room says what is missing.
		expect(at('/new-resource')).toEqual({ kind: 'place', place: 'new-resource' });
	});

	it('keys a create room by its place and its context — two contexts are two rooms', () => {
		const notes = at('/new-resource?context=%2Bpete%2Fnotes');
		const work = at('/new-resource?context=%2Bpete%2Fwork');
		expect(notes && work && subjectKey(notes) !== subjectKey(work)).toBe(true);
		expect(notes && subjectKey(notes)).toBe('place:new-resource:+pete/notes');
		// A place that names no context keys as it always did.
		expect(subjectKey({ kind: 'place', place: 'settings' })).toBe('place:settings');
	});

	it('is called by its words, never its id', () => {
		expect(subjectWords({ kind: 'place', place: 'new-resource' })).toBe('new resource');
	});

	it('round-trips through the store, and drops a context that is not a reference', () => {
		const subject = { kind: 'place', place: 'new-resource', context: '+pete/notes' } as const;
		expect(parseSubject(JSON.parse(JSON.stringify(subject)))).toEqual(subject);
		expect(parseSubject({ kind: 'place', place: 'new-resource', context: 7 })).toEqual({
			kind: 'place',
			place: 'new-resource'
		});
	});

	it('addresses the place, the context query-stringed when named', () => {
		expect(placeHref('new-resource')).toBe('/new-resource');
		expect(placeHref('new-resource', '+pete/notes')).toBe('/new-resource?context=%2Bpete%2Fnotes');
	});
});

describe('the presentation subject', () => {
	const record = { resource: ID, artifact: '01a0f100-0000-7000-8000-000000000001' };
	const subject = { kind: 'presentation', ...record } as const;

	it('is what its words call it — never a guessed title', () => {
		expect(subjectWords(subject)).toBe('presented view');
	});

	it('keys on the pair, and only the pair', () => {
		expect(subjectKey(subject)).toBe(`presentation:${record.resource}:${record.artifact}`);
		const other = { ...subject, artifact: '01a0f100-0000-7000-8000-000000000002' };
		expect(subjectKey(other)).not.toBe(subjectKey(subject));
	});

	it('round-trips through the store, and refuses a stray or missing field', () => {
		const restored = parseSubject(JSON.parse(JSON.stringify(subject)));
		expect(restored).toEqual(subject);
		expect(parseSubject({ kind: 'presentation', resource: record.resource })).toBeNull();
		expect(parseSubject({ kind: 'presentation', artifact: record.artifact })).toBeNull();
		expect(parseSubject({ kind: 'presentation' })).toBeNull();
	});
});
