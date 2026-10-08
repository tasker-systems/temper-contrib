import { describe, expect, it } from 'vitest';
import { core } from './contributions/core';
import { loadContributions } from './contributions/packages';
import { pluginManifestText } from './contributions/plugin-fixture';
import { type Contribution, createMenu, homeSections, lensesFor, resolveLens } from './lenses';
import type { Subject } from './subjects';

/** temper-workflows, as the loader now answers for it — the packages' shape, loaded. */
const temperWorkflows: Contribution = loadContributions([
	{
		name: 'temper-workflows',
		files: [{ path: 'plugin.json', text: pluginManifestText() }]
	}
]).contributions[0];

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
	vocabularies: [{ id: 'create', doctypes: [{ doctype: 'task' }] }],
	skills: []
});

/** A plugin whose create vocabulary re-declares a base doctype with defaults of its own. */
const opinionated = (doctype: string, open: Record<string, unknown>): Contribution => ({
	plugin: 'practice',
	lenses: [],
	waysIn: [],
	vocabularies: [{ id: 'create', doctypes: [{ doctype, defaults: () => open }] }],
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
		// ...and a context opens on the bound table by default, not the unbuilt shape lens...
		const table = resolveLens(context, null, null, [core]);
		expect(table?.lens.id).toBe('core/table');
		expect(table?.lens.build.state).toBe('bound');
		// ...while the neighbourhood, which only the graph lens accepts, opens on it.
		const graph = resolveLens(
			{ kind: 'neighbourhood', id: resource.id as string, depth: 1 },
			null,
			null,
			[core]
		);
		expect(graph?.lens.id).toBe('core/graph');
		expect(graph?.lens.build.state).toBe('bound');
	});

	it('the graph lens takes a neighbourhood, a resource, or a query that names a context', () => {
		const asked = (subject: Subject) =>
			resolveLens(subject, null, 'core/graph', [core])?.lens.id ?? null;
		expect(asked({ kind: 'neighbourhood', id: resource.id as string, depth: 1 })).toBe(
			'core/graph'
		);
		expect(asked(resource)).toBe('core/graph');
		expect(asked(context)).toBe('core/graph');
		// A query that names no context is not the graph lens's to show — the table stays.
		const docTypeOnly = resolveLens({ kind: 'query', docType: 'task' }, null, 'core/graph', [core]);
		expect(docTypeOnly?.lens.id).toBe('core/table');
		expect(docTypeOnly?.reason).toBe('default');
	});
});

describe('the lens switcher', () => {
	it('offers every enabled lens that accepts the subject, built or not', () => {
		expect(lensesFor(resource, 'task', [core]).map((l) => l.id)).toEqual([
			'core/document',
			'core/graph'
		]);
		// A context is seen through the table by default, and the switcher offers the graph too.
		expect(lensesFor(context, null, [core]).map((l) => l.id)).toEqual([
			'core/table',
			'core/graph',
			'core/shape'
		]);
	});

	it('never offers a place lens — a place has one way of being seen', () => {
		expect(lensesFor({ kind: 'place', place: 'home' }, null, [core])).toEqual([]);
		expect(lensesFor(resource, null, [core]).some((l) => l.accepts.kinds.includes('place'))).toBe(
			false
		);
	});
});

describe("home's sections", () => {
	it('are the enabled lenses pinned to home, in order, and never the frame itself', () => {
		const ids = homeSections([core, temperWorkflows]).map((s) => s.lens.id);
		expect(ids).toEqual([
			'core/home-resume',
			'temper-workflows/home-handoff',
			'core/home-asks',
			'temper-workflows/home-recent',
			'core/home-presented',
			'core/home-start',
			'core/home-explore'
		]);
		expect(ids).not.toContain('core/home');
	});

	it('share one heading per group: the first section of a run opens it', () => {
		const headings = homeSections([core, temperWorkflows]).map((s) => s.heading);
		expect(headings).toEqual([
			'Resume',
			null,
			'Awaiting you',
			null,
			'Presented views',
			'Start',
			'Explore'
		]);
	});

	it('without the workflow plugin, its sections vanish and home still reads whole', () => {
		const sections = homeSections([core]);
		expect(sections.map((s) => s.lens.id)).toEqual([
			'core/home-resume',
			'core/home-asks',
			'core/home-presented',
			'core/home-start',
			'core/home-explore'
		]);
		expect(sections.every((s) => s.heading !== null)).toBe(true);
	});

	it('leave home resolving to the frame, and offer no lens switch on it', () => {
		const home: Subject = { kind: 'place', place: 'home' };
		expect(resolveLens(home, null, 'core/home', [core, temperWorkflows])).toMatchObject({
			lens: { id: 'core/home' }
		});
		expect(resolveLens(home, null, null, [core, temperWorkflows])).toMatchObject({
			lens: { id: 'core/home' }
		});
		expect(lensesFor(home, null, [core, temperWorkflows])).toEqual([]);
	});
});

describe('the create menu', () => {
	const today = '2026-10-02';

	it('yields the six with temper-workflows’ defaults — a date for sessions and research, none for the rest', () => {
		const menu = createMenu([core, temperWorkflows], today);
		expect(menu.map((option) => option.doctype)).toEqual([
			'task',
			'goal',
			'session',
			'research',
			'concept',
			'decision'
		]);
		const defaults = new Map(menu.map((option) => [option.doctype, option.defaults]));
		expect(defaults.get('session')).toEqual({ date: today });
		expect(defaults.get('research')).toEqual({ date: today });
		expect(defaults.get('task')).toBeUndefined();
		expect(defaults.get('goal')).toBeUndefined();
		expect(defaults.get('concept')).toBeUndefined();
		expect(defaults.get('decision')).toBeUndefined();
	});

	it('with core alone, the base six with no defaults — creation works rather than nothing', () => {
		const menu = createMenu([core], today);
		expect(menu.map((option) => option.doctype)).toEqual([
			'task',
			'goal',
			'session',
			'research',
			'concept',
			'decision'
		]);
		expect(menu.every((option) => option.defaults === undefined)).toBe(true);
	});

	it('a doctype both core and a plugin declare appears once, with the plugin’s defaults', () => {
		const menu = createMenu([core, opinionated('task', { date: today })], today);
		const tasks = menu.filter((option) => option.doctype === 'task');
		expect(tasks).toHaveLength(1);
		expect(tasks[0].defaults).toEqual({ date: today });
		// Still the six, and a doctype the plugin stayed silent on keeps the base's plain entry.
		expect(menu).toHaveLength(6);
		expect(menu.find((option) => option.doctype === 'goal')?.defaults).toBeUndefined();
	});
});
