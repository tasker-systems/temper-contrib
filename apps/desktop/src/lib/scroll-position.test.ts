import { beforeEach, describe, expect, it } from 'vitest';
import {
	anchorIndex,
	anchorText,
	capture,
	clearPosition,
	type HeadingOccurrence,
	POSITION_BOUND,
	readPosition,
	restoreTop,
	SCROLL_STORE_KEY,
	savePosition
} from './scroll-position';

/** A device store in memory, so each test starts from exactly what it stored. */
class MemoryStorage implements Storage {
	#items = new Map<string, string>();
	get length() {
		return this.#items.size;
	}
	clear() {
		this.#items.clear();
	}
	getItem(key: string) {
		return this.#items.get(key) ?? null;
	}
	key(i: number) {
		return [...this.#items.keys()][i] ?? null;
	}
	removeItem(key: string) {
		this.#items.delete(key);
	}
	setItem(key: string, value: string) {
		this.#items.set(key, value);
	}
}

let storage: MemoryStorage;

beforeEach(() => {
	storage = new MemoryStorage();
});

describe('capture', () => {
	const headings: HeadingOccurrence[] = [
		{ text: '# Goals', index: 0, top: 100 },
		{ text: '## Risks', index: 0, top: 500 },
		{ text: '## Risks', index: 1, top: 900 }
	];

	it('reads the preamble when the top has not reached the first heading', () => {
		expect(capture(headings, 50, 3000)).toEqual({ heading: null, fraction: 0 });
	});

	it('names the nearest preceding heading and the fraction through its section', () => {
		// 300 is 200/400 of the way through the Goals section (100–500).
		expect(capture(headings, 300, 3000)).toEqual({ heading: '# Goals#0', fraction: 0.5 });
	});

	it('reads the last section as running to the document bottom', () => {
		// 1000 is 100 past the second Risks heading; its section runs to the bottom (3000).
		const position = capture(headings, 1000, 3000);
		expect(position.heading).toBe('## Risks#1');
		expect(position.fraction).toBeCloseTo(100 / 2000);
	});

	it('distinguishes repeated headings by their ordinal among equals', () => {
		const position = capture(headings, 600, 3000);
		expect(position.heading).toBe('## Risks#0');
	});

	it('clamps a top past the document bottom to a fraction of 1', () => {
		const position = capture(headings, 4000, 3000);
		expect(position.fraction).toBeLessThanOrEqual(1);
		expect(position.heading).toBe('## Risks#1');
	});

	it('handles a body with no headings at all as the preamble', () => {
		expect(capture([], 100, 3000)).toEqual({ heading: null, fraction: 0 });
	});
});

describe('restoreTop', () => {
	const headings: HeadingOccurrence[] = [
		{ text: '# Goals', index: 0, top: 100 },
		{ text: '## Risks', index: 0, top: 500 },
		{ text: '## Risks', index: 1, top: 900 }
	];

	it('answers the anchor heading plus the fraction of its section', () => {
		expect(restoreTop('# Goals', 0.5, headings, 3000, 600)).toBe(300);
	});

	it('seeks the ordinal the anchor names among repeated headings', () => {
		expect(restoreTop('## Risks#1', 0, headings, 3000, 600)).toBe(900);
		expect(restoreTop('## Risks#0', 0, headings, 3000, 600)).toBe(500);
	});

	it('answers the first of its equals when the ordinal overruns what the body holds', () => {
		// The body kept one Risks; the anchor named the second. The first stands in.
		expect(restoreTop('## Risks#1', 0, headings.slice(0, 2), 3000, 600)).toBe(500);
	});

	it('is null when the body no longer holds the heading — the room says so', () => {
		expect(restoreTop('## Gone', 0.5, headings, 3000, 600)).toBeNull();
		expect(restoreTop('# Goals', 0.5, [], 3000, 600)).toBeNull();
	});

	it('clamps the target to what the body can scroll', () => {
		// A full last-section fraction would run past the scrollable bottom.
		const top = restoreTop('## Risks#1', 1, headings, 3000, 600);
		expect(top).toBeLessThanOrEqual(3000 - 600);
	});
});

describe('the device store', () => {
	it("saves and reads one resource's position", () => {
		savePosition(storage, 'r1', { heading: '# Goals', fraction: 0.5 });
		expect(readPosition(storage, 'r1')).toEqual({ heading: '# Goals', fraction: 0.5 });
	});

	it('answers null when this device holds no position for the resource', () => {
		expect(readPosition(storage, 'absent')).toBeNull();
	});

	it("is device-local: one resource's save does not touch another's", () => {
		savePosition(storage, 'r1', { heading: '# Goals', fraction: 0.5 });
		savePosition(storage, 'r2', { heading: '## Risks', fraction: 0.25 });
		expect(readPosition(storage, 'r1')).toEqual({ heading: '# Goals', fraction: 0.5 });
		expect(readPosition(storage, 'r2')).toEqual({ heading: '## Risks', fraction: 0.25 });
	});

	it('a later save overwrites the earlier one for the same resource', () => {
		savePosition(storage, 'r1', { heading: '# Goals', fraction: 0.5 });
		savePosition(storage, 'r1', { heading: '## Risks', fraction: 0.25 });
		expect(readPosition(storage, 'r1')).toEqual({ heading: '## Risks', fraction: 0.25 });
	});

	it('is bounded, dropping the oldest places of work', () => {
		for (let i = 0; i <= POSITION_BOUND; i++) {
			savePosition(storage, `r${i}`, { heading: null, fraction: 0 });
		}
		expect(readPosition(storage, 'r0')).toBeNull();
		expect(readPosition(storage, `r${POSITION_BOUND}`)).not.toBeNull();
	});

	it('a corrupted store answers nothing, never an error', () => {
		storage.setItem(SCROLL_STORE_KEY, 'not json');
		expect(readPosition(storage, 'r1')).toBeNull();
		// And a save through the broken store does not throw.
		expect(() => savePosition(storage, 'r1', { heading: null, fraction: 0 })).not.toThrow();
	});

	it('a store that refuses writes stays silent', () => {
		const refusing: Storage = Object.assign(storage, {
			setItem: () => {
				throw new Error('quota');
			}
		});
		expect(() => savePosition(refusing, 'r1', { heading: null, fraction: 0 })).not.toThrow();
		expect(() => clearPosition(refusing, 'r1')).not.toThrow();
	});

	it('a null storage — tests, SSR — reads and saves nothing', () => {
		expect(() => savePosition(null, 'r1', { heading: null, fraction: 0 })).not.toThrow();
		expect(readPosition(null, 'r1')).toBeNull();
	});

	it('clamps a malformed stored fraction to the range it names', () => {
		storage.setItem(SCROLL_STORE_KEY, JSON.stringify({ r1: { heading: '# Goals', fraction: 7 } }));
		expect(readPosition(storage, 'r1')).toEqual({ heading: '# Goals', fraction: 1 });
		storage.setItem(SCROLL_STORE_KEY, JSON.stringify({ r1: { heading: null, fraction: 'x' } }));
		expect(readPosition(storage, 'r1')).toEqual({ heading: null, fraction: 0 });
	});

	it('clearing forgets one resource and leaves the rest', () => {
		savePosition(storage, 'r1', { heading: '# Goals', fraction: 0.5 });
		savePosition(storage, 'r2', { heading: '## Risks', fraction: 0.25 });
		clearPosition(storage, 'r1');
		expect(readPosition(storage, 'r1')).toBeNull();
		expect(readPosition(storage, 'r2')).not.toBeNull();
	});
});

describe('anchors', () => {
	it('an anchor always carries its ordinal, appended by capture', () => {
		expect(anchorText('# Goals#0')).toBe('# Goals');
		expect(anchorIndex('# Goals#0')).toBe(0);
	});

	it('an anchor with a non-zero ordinal carries both halves', () => {
		expect(anchorText('## Risks#1')).toBe('## Risks');
		expect(anchorIndex('## Risks#1')).toBe(1);
	});

	it('a heading whose own text ends in a hash-digit pair still round-trips', () => {
		// The anchor of `# C#2` is `# C#2#1` — the last tail is the ordinal, the rest the text.
		expect(anchorText('# C#2#0')).toBe('# C#2');
		expect(anchorIndex('# C#2#0')).toBe(0);
	});

	it('an anchor with no ordinal tail reads as the zeroth occurrence', () => {
		expect(anchorText('# Notes#')).toBe('# Notes');
		expect(anchorIndex('# Notes#')).toBe(0);
	});
});
