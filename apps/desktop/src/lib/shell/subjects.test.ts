import { describe, expect, it } from 'vitest';
import { roomHref as resourceHref } from '$lib/document';
import {
	contextHref,
	parseSubject,
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
