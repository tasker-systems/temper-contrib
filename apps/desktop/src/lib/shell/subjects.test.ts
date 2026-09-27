import { describe, expect, it } from 'vitest';
import { roomHref as resourceHref } from '$lib/document';
import { contextHref, subjectFromAddress, subjectKey } from './subjects';

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
