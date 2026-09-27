import { describe, expect, it } from 'vitest';
import { core } from './contributions/core';
import { type Contribution, lensesFor, resolveLens } from './lenses';
import type { Subject } from './subjects';

const resource: Subject = { kind: 'resource', id: '01a0e020-a6d7-7420-b924-68f5e89f354b' };
const context: Subject = { kind: 'query', context: '+temper-dev/contrib' };

/** A plugin that declares a lens for tasks — the shape rule 2 reads. */
const workflows = (state: 'built' | 'unbuilt'): Contribution => ({
	plugin: 'temper-workflows',
	lenses: [
		{
			id: 'temper-workflows/tasks',
			name: 'tasks',
			plugin: 'temper-workflows',
			accepts: { kinds: ['resource'], docTypes: ['task'] },
			build:
				state === 'built'
					? { state: 'built', component: async () => ({ default: (() => {}) as never }) }
					: { state: 'unbuilt', landsWith: 'the tasks lens' }
		}
	],
	waysIn: [],
	vocabularies: [],
	skills: []
});

describe('resolving a lens', () => {
	it('rule 1: the lens a link asked for, when it accepts the subject', () => {
		expect(resolveLens(resource, 'task', 'core/graph', [core])).toMatchObject({
			lens: { id: 'core/graph' },
			reason: 'asked'
		});
	});

	it('rule 1 does not bend: an asked lens that does not accept the subject is passed over', () => {
		expect(resolveLens(resource, 'task', 'core/shape', [core])).toMatchObject({
			lens: { id: 'core/document' },
			reason: 'default'
		});
	});

	it('rule 2: the first enabled non-core lens that declares the doc type', () => {
		expect(resolveLens(resource, 'task', null, [core, workflows('built')])).toMatchObject({
			lens: { id: 'temper-workflows/tasks' },
			reason: 'declared'
		});
		expect(resolveLens(resource, 'research', null, [core, workflows('built')])).toMatchObject({
			lens: { id: 'core/document' },
			reason: 'default'
		});
	});

	it('rule 3: core’s default for the subject’s kind', () => {
		expect(resolveLens(resource, null, null, [core])?.lens.id).toBe('core/document');
		expect(resolveLens(context, null, null, [core])?.lens.id).toBe('core/table');
		expect(
			resolveLens({ kind: 'neighbourhood', id: resource.id as string, depth: 1 }, null, null, [
				core
			])?.lens.id
		).toBe('core/graph');
		expect(resolveLens({ kind: 'place', place: 'settings' }, null, null, [core])?.lens.id).toBe(
			'core/settings'
		);
	});

	it('an unbuilt lens is chosen only when it is the only candidate', () => {
		// A declared lens that is not built yet loses to core's built default...
		expect(resolveLens(resource, 'task', null, [core, workflows('unbuilt')])?.lens.id).toBe(
			'core/document'
		);
		// ...and a context, which only unbuilt lenses accept, opens on the unbuilt table lens.
		const table = resolveLens(context, null, null, [core]);
		expect(table?.lens.id).toBe('core/table');
		expect(table?.lens.build.state).toBe('unbuilt');
	});
});

describe('the lens switcher', () => {
	it('offers every enabled lens that accepts the subject, built or not', () => {
		expect(lensesFor(resource, 'task', [core]).map((l) => l.id)).toEqual([
			'core/document',
			'core/table',
			'core/graph'
		]);
		expect(lensesFor(context, null, [core]).map((l) => l.id)).toEqual(['core/table', 'core/shape']);
	});

	it('never offers a place lens — a place has one way of being seen', () => {
		expect(lensesFor({ kind: 'place', place: 'home' }, null, [core])).toEqual([]);
		expect(lensesFor(resource, null, [core]).some((l) => l.accepts.kinds.includes('place'))).toBe(
			false
		);
	});
});
