import { describe, expect, it } from 'vitest';
import { refId, roomHref } from './document';

const A = '01a0e020-a6d7-7420-b924-68f5e89f354b';

describe('a room’s address', () => {
	it('names a room by the id a reference carries, bare or decorated', () => {
		expect(refId(A)).toBe(A);
		expect(refId(`build-the-room-${A}`)).toBe(A);
		expect(refId('not-a-reference')).toBeNull();
	});

	it('names only its target — never where it was followed from', () => {
		expect(roomHref(`a-slug-${A}`)).toBe(`/r/a-slug-${A}`);
	});
});
