import { beforeEach, describe, expect, it } from 'vitest';
import { type HubLeave, leaveOf, startHubWriter } from './hub-writer';
import type { Subject } from './subjects';
import { TabModel } from './tabs.svelte';

const id = (n: number) => `01a0e020-a6d7-7420-b924-${String(n).padStart(12, '0')}`;
const doc = (n: number): Subject => ({ kind: 'resource', id: id(n) });

let clock: number;
let model: TabModel;
let noted: HubLeave[];
const note = async (leave: HubLeave) => {
	noted.push(leave);
};

beforeEach(() => {
	clock = Date.parse('2026-09-28T10:00:00.000Z');
	model = new TabModel(null, () => clock);
	noted = [];
});

describe('the hub writer', () => {
	it('reports each resource room left, under the lens it was seen through', () => {
		startHubWriter(model, note, {});
		model.open(doc(1), { where: 'new' });
		model.resolved(model.current(model.active).key, 'core/document', 'task');
		clock += 60_000;
		model.open(doc(2));
		expect(noted).toEqual([
			{
				resource: id(1),
				room: 'core/document',
				openedAt: '2026-09-28T10:00:00.000Z',
				leftAt: '2026-09-28T10:01:00.000Z'
			}
		]);
	});

	it('never reports home or any place', () => {
		startHubWriter(model, note, {});
		model.open({ kind: 'place', place: 'settings' }, { where: 'new' });
		clock += 60_000;
		model.activate('home');
		expect(noted).toEqual([]);
		expect(leaveOf(model.current(model.active), 0, 1)).toBeNull();
	});

	it('the window hiding leaves the room in view, and showing it enters again', () => {
		const target = new EventTarget() as unknown as Document & { visibilityState: string };
		let visibility = 'visible';
		Object.defineProperty(target, 'visibilityState', { get: () => visibility });
		startHubWriter(model, note, { document: target });
		model.open(doc(1), { where: 'new' });
		clock += 30_000;
		visibility = 'hidden';
		target.dispatchEvent(new Event('visibilitychange'));
		expect(noted).toHaveLength(1);
		clock += 30_000;
		visibility = 'visible';
		target.dispatchEvent(new Event('visibilitychange'));
		clock += 30_000;
		model.activate('home');
		expect(noted).toHaveLength(2);
		expect(noted[1].openedAt).toBe('2026-09-28T10:01:00.000Z');
	});

	it('stops when asked', () => {
		const stop = startHubWriter(model, note, {});
		stop();
		model.open(doc(1), { where: 'new' });
		clock += 60_000;
		model.activate('home');
		expect(noted).toEqual([]);
	});
});
