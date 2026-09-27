import { describe, expect, it } from 'vitest';
import { parseWalk, refId, roomHref, WALK_BOUND, walkOn, wayOutOf } from './document';

const A = '01a0e020-a6d7-7420-b924-68f5e89f354b';
const B = '01a0e2a1-34a8-7a63-8fd6-cd3220c36191';
const C = '01a0d873-59c9-72f0-a31f-23f0da5d8789';

describe('the walk', () => {
	it('names a room by the id a reference carries, bare or decorated', () => {
		expect(refId(A)).toBe(A);
		expect(refId(`build-the-room-${A}`)).toBe(A);
		expect(refId('not-a-reference')).toBeNull();
	});

	it('a room entered directly has no walk, and its way out is home', () => {
		expect(roomHref(`a-slug-${A}`)).toBe(`/r/a-slug-${A}`);
		expect(wayOutOf([])).toEqual({ href: '/', label: 'home' });
	});

	it('walking on remembers where the walk came from, as ids', () => {
		expect(walkOn(B, `a-slug-${A}`, [])).toBe(`/r/${B}?walk=${A}`);
		expect(walkOn(C, B, [A])).toBe(`/r/${C}?walk=${A},${B}`);
	});

	it('the way out walks back one room at a time, then home', () => {
		// In C, entered from B, which was entered from A.
		const inC = wayOutOf([A, B]);
		expect(inC).toEqual({ href: `/r/${B}?walk=${A}`, label: 'back' });
		// That address is B's own room, entered from A: its way out is A, whose way out is home.
		const inB = wayOutOf(parseWalk(new URL(inC.href, 'http://x').searchParams.get('walk')));
		expect(inB).toEqual({ href: `/r/${A}`, label: 'back' });
		expect(wayOutOf(parseWalk(new URL(inB.href, 'http://x').searchParams.get('walk')))).toEqual({
			href: '/',
			label: 'home'
		});
	});

	it('drops what is not a reference and keeps only the newest steps', () => {
		expect(parseWalk(`${A},junk,${B}`)).toEqual([A, B]);
		const long = Array.from({ length: WALK_BOUND + 5 }, () => A);
		expect(parseWalk(long.join(','))).toHaveLength(WALK_BOUND);
		expect(walkOn(B, A, long).split('walk=')[1].split(',')).toHaveLength(WALK_BOUND);
	});
});
