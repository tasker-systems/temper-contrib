import { beforeEach, describe, expect, it } from 'vitest';
import type { Subject } from './subjects';
import { HOME_TAB, SET_ASIDE_BOUND, TAB_BOUND, TabModel, TRAIL_BOUND } from './tabs.svelte';

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

const doc = (n: number): Subject => ({
	kind: 'resource',
	id: `01a0e020-a6d7-7420-b924-${String(n).padStart(12, '0')}`
});

let storage: MemoryStorage;
let clock: number;
let model: TabModel;

beforeEach(() => {
	storage = new MemoryStorage();
	clock = 1000;
	model = new TabModel(storage, () => clock);
});

describe('the tab model', () => {
	it('starts on the pinned home tab alone', () => {
		expect(model.tabs.map((t) => t.id)).toEqual([HOME_TAB]);
		expect(model.activeId).toBe(HOME_TAB);
		expect(model.openCount).toBe(0);
	});

	it('never replaces home: a link followed from home opens a new tab', () => {
		expect(model.open(doc(1), { where: 'here' })).toBe(true);
		expect(model.tabs).toHaveLength(2);
		expect(model.current(model.tabs[0]).subject).toEqual({ kind: 'place', place: 'home' });
		expect(model.activeId).not.toBe(HOME_TAB);
	});

	it('home cannot be closed', () => {
		expect(model.close(HOME_TAB)).toBe(false);
		expect(model.tabs.map((t) => t.id)).toEqual([HOME_TAB]);
	});

	it('follows a link in place, and walks back and forward along the trail', () => {
		model.open(doc(1), { where: 'new' });
		model.open(doc(2));
		model.open(doc(3));
		const tab = model.active;
		expect(tab.steps.map((s) => s.subject)).toEqual([doc(1), doc(2), doc(3)]);
		expect(model.back()).toBe(true);
		expect(model.current(tab).subject).toEqual(doc(2));
		expect(model.forward()).toBe(true);
		expect(model.current(tab).subject).toEqual(doc(3));
		expect(model.forward()).toBe(false);
	});

	it('following a link after walking back drops the steps ahead', () => {
		model.open(doc(1), { where: 'new' });
		model.open(doc(2));
		model.back();
		model.open(doc(3));
		expect(model.active.steps.map((s) => s.subject)).toEqual([doc(1), doc(3)]);
		expect(model.canForward(model.active)).toBe(false);
	});

	it('bounds the trail, dropping the oldest step', () => {
		model.open(doc(0), { where: 'new' });
		for (let i = 1; i <= TRAIL_BOUND + 4; i++) model.open(doc(i));
		const tab = model.active;
		expect(tab.steps).toHaveLength(TRAIL_BOUND);
		expect(tab.steps[0].subject).toEqual(doc(5));
		expect(model.current(tab).subject).toEqual(doc(TRAIL_BOUND + 4));
	});

	it('switching lens keeps the subject, the step and the trail', () => {
		model.open(doc(1), { where: 'new' });
		model.open(doc(2));
		const tab = model.active;
		const before = model.current(tab);
		model.resolved(before.key, 'core/document', 'task');
		model.setLens(tab.id, 'core/graph');
		const after = model.current(tab);
		expect(after.key).toBe(before.key);
		expect(after.subject).toEqual(doc(2));
		expect(after.lens).toBe('core/graph');
		expect(after.docType).toBe('task');
		expect(tab.steps.map((s) => s.subject)).toEqual([doc(1), doc(2)]);
	});

	it('a thirteenth tab sets the least-recently-used one aside, and says which', () => {
		for (let i = 0; i < TAB_BOUND; i++) {
			clock += 1;
			model.open(doc(i), { where: 'new' });
		}
		const oldest = model.tabs[1];
		model.setTitle(model.current(oldest).key, 'Chapter 3');
		// Showing the oldest again makes the second-oldest the least recently used.
		clock += 1;
		model.activate(oldest.id);
		const leastUsed = model.tabs[2];
		clock += 1;
		expect(model.open(doc(99), { where: 'new' })).toBe(true);

		expect(model.openCount).toBe(TAB_BOUND);
		expect(model.tabs.some((t) => t.id === leastUsed.id)).toBe(false);
		expect(model.setAside.map((t) => t.id)).toEqual([leastUsed.id]);
		expect(model.mounted[leastUsed.id]).toBeUndefined();
		expect(model.notice).toBe(`Set aside document to open document.`);
	});

	it('a set-aside tab reopens with its trail intact, and is found by what it shows', () => {
		model.open(doc(0), { where: 'new' });
		model.open(doc(1));
		const first = model.activeId;
		for (let i = 2; i <= TAB_BOUND + 1; i++) {
			clock += 1;
			model.open(doc(i), { where: 'new' });
		}
		expect(model.setAside.map((t) => t.id)).toEqual([first]);

		expect(model.focusOrOpen(doc(1))).toBe(true);
		expect(model.activeId).toBe(first);
		expect(model.active.steps.map((s) => s.subject)).toEqual([doc(0), doc(1)]);
		expect(model.setAside.map((t) => t.id)).not.toContain(first);
		expect(model.openCount).toBe(TAB_BOUND);
		expect(model.setAside).toHaveLength(1);
	});

	it('a tab that declines to leave is never set aside; when all decline, the open is refused with words', () => {
		for (let i = 0; i < TAB_BOUND; i++) {
			clock += 1;
			model.open(doc(i), { where: 'new' });
		}
		const [, drafting, ...rest] = model.tabs;
		model.handle(drafting.id, model.current(drafting).key).beforeLeave(() => 'Unsaved draft.');
		expect(model.open(doc(50), { where: 'new' })).toBe(true);
		expect(model.tabs.some((t) => t.id === drafting.id)).toBe(true);

		for (const tab of [...model.tabs.slice(1)]) {
			model.handle(tab.id, model.current(tab).key).beforeLeave(() => 'Unsaved draft.');
		}
		void rest;
		expect(model.open(doc(51), { where: 'new' })).toBe(false);
		expect(model.notice).toContain('none can be set aside without losing work');
		expect(model.openCount).toBe(TAB_BOUND);
	});

	it('the set-aside list is bounded, oldest dropped', () => {
		for (let i = 0; i < TAB_BOUND + SET_ASIDE_BOUND + 5; i++) {
			clock += 1;
			model.open(doc(i), { where: 'new' });
		}
		expect(model.setAside).toHaveLength(SET_ASIDE_BOUND);
	});

	it('focuses a tab already showing a subject before opening another', () => {
		model.focusOrOpen({ kind: 'place', place: 'settings' });
		const settings = model.activeId;
		model.activate(HOME_TAB);
		model.focusOrOpen({ kind: 'place', place: 'settings' });
		expect(model.activeId).toBe(settings);
		expect(model.openCount).toBe(1);
	});

	it('closing the active tab activates its neighbour', () => {
		model.open(doc(1), { where: 'new' });
		const first = model.activeId;
		model.open(doc(2), { where: 'new' });
		const second = model.activeId;
		model.activate(first);
		model.close(first);
		expect(model.activeId).toBe(second);
		model.close(second);
		expect(model.activeId).toBe(HOME_TAB);
	});

	it('mounts a tab on first activation and keeps it mounted', () => {
		model.open(doc(1), { where: 'new' });
		const tab = model.activeId;
		model.activate(HOME_TAB);
		expect(model.mounted[tab]).toBe(true);
	});

	it('a lens that declines to leave keeps its step, and the refusal says why', () => {
		model.open(doc(1), { where: 'new' });
		const tab = model.active;
		const handle = model.handle(tab.id, model.current(tab).key);
		const release = handle.beforeLeave(() => 'The draft is unsaved.');
		expect(model.open(doc(2))).toBe(false);
		expect(model.close(tab.id)).toBe(false);
		expect(model.notice).toBe('The draft is unsaved.');
		release();
		expect(model.open(doc(2))).toBe(true);
	});

	it('tells a listener when a room is left, with when it was entered', () => {
		const left: Array<[string, number, number]> = [];
		model.onLeave((step, openedAt, leftAt) => left.push([step.subject.kind, openedAt, leftAt]));
		model.open(doc(1), { where: 'new' });
		clock = 2000;
		model.open(doc(2));
		clock = 3000;
		model.close(model.activeId);
		expect(left).toEqual([
			['resource', 1000, 2000],
			['resource', 2000, 3000]
		]);
	});
});

describe('restoring the tabs', () => {
	it('restores tabs, trails, cursors, titles and the active tab — and mounts only the active one', () => {
		model.open(doc(1), { where: 'new' });
		model.open(doc(2));
		model.setTitle(model.current(model.active).key, 'Chapter 2');
		model.back();
		const kept = model.activeId;
		model.open(doc(3), { where: 'new' });
		model.activate(kept);

		const restored = new TabModel(storage);
		expect(restored.tabs.map((t) => t.id)).toEqual(model.tabs.map((t) => t.id));
		expect(restored.activeId).toBe(kept);
		const tab = restored.active;
		expect(tab.cursor).toBe(0);
		expect(tab.steps[1].title).toBe('Chapter 2');
		expect(Object.keys(restored.mounted)).toEqual([kept]);
	});

	it('restores the set-aside tabs, and reopens them with their trails', () => {
		model.open(doc(0), { where: 'new' });
		model.open(doc(1));
		for (let i = 2; i <= TAB_BOUND + 1; i++) {
			clock += 1;
			model.open(doc(i), { where: 'new' });
		}
		const aside = model.setAside.map((t) => t.id);
		expect(aside).toHaveLength(1);

		const restored = new TabModel(storage, () => clock);
		expect(restored.setAside.map((t) => t.id)).toEqual(aside);
		expect(restored.reopen(aside[0])).toBe(true);
		expect(restored.active.steps.map((s) => s.subject)).toEqual([doc(0), doc(1)]);
	});

	it('an unreadable store yields home alone, never an error', () => {
		storage.setItem('temper-shell-tabs-v1', '{not json');
		const restored = new TabModel(storage);
		expect(restored.tabs.map((t) => t.id)).toEqual([HOME_TAB]);
		expect(restored.activeId).toBe(HOME_TAB);
	});

	it('a store that throws yields home alone', () => {
		const throwing = {
			getItem() {
				throw new Error('denied');
			},
			setItem() {
				throw new Error('denied');
			}
		} as unknown as Storage;
		const restored = new TabModel(throwing);
		expect(restored.tabs.map((t) => t.id)).toEqual([HOME_TAB]);
		expect(restored.open(doc(1), { where: 'new' })).toBe(true);
	});

	it('drops what is not a tab and keeps what is', () => {
		storage.setItem(
			'temper-shell-tabs-v1',
			JSON.stringify({
				v: 1,
				active: 'gone',
				tabs: [
					{ id: 'a', cursor: 9, steps: [{ key: 'k1', subject: doc(1) }] },
					{ id: 'b', cursor: 0, steps: [{ key: 'k2', subject: { kind: 'nonsense' } }] },
					{ id: HOME_TAB, cursor: 0, steps: [{ key: 'k3', subject: doc(3) }] }
				]
			})
		);
		const restored = new TabModel(storage);
		expect(restored.tabs.map((t) => t.id)).toEqual([HOME_TAB, 'a']);
		expect(restored.tabs[1].cursor).toBe(0);
		expect(restored.activeId).toBe(HOME_TAB);
	});
});
