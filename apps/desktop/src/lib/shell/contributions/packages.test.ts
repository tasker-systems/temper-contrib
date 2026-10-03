/**
 * The package loader's witnesses. The manifest format is closed, so every way a package can be
 * wrong is a refusal — one sentence naming the package, the fault and the field path, and never
 * a half-loaded package: an unknown component, an unknown default kind, an unknown subject kind,
 * an extra key (a lens carrying a plugin of its own included), a lens id its own package name
 * does not namespace, a manifest that is not JSON, a package with no manifest. And the
 * differential: what loads from the shipped temper-workflows manifest is what temper-workflows.ts
 * used to export, the component closures apart. The loader takes injected sources only — any
 * package name, any file names, no disk, no repo path.
 */
import { describe, expect, it } from 'vitest';
import type { Contribution } from '../lenses';
import { loadContributions } from './packages';
import { pluginManifestText } from './plugin-fixture';

const packageWith = (text: string) => [
	{ name: 'temper-workflows', files: [{ path: 'plugin.json', text }] }
];

const loadOne = (text: string) => loadContributions(packageWith(text));

/** A variant of the shipped manifest with one lens rewritten, as a refusing package would be. */
const withLens = (lens: Record<string, unknown>) => {
	const manifest = JSON.parse(pluginManifestText()) as {
		contributions: { lenses: Record<string, unknown>[] };
	};
	manifest.contributions.lenses[0] = lens;
	return JSON.stringify(manifest);
};

const TODAY = '2026-10-03';

/** What temper-workflows.ts exported the day this package was born, its closures named apart. */
const wasTemperWorkflows = {
	plugin: 'temper-workflows',
	lenses: [
		{
			id: 'temper-workflows/home-handoff',
			name: 'latest handoff',
			plugin: 'temper-workflows',
			accepts: { kinds: ['place'], places: ['home'] },
			pinned: { home: 15 },
			group: 'Resume',
			build: { state: 'built' }
		},
		{
			id: 'temper-workflows/home-recent',
			name: 'recently updated',
			plugin: 'temper-workflows',
			accepts: { kinds: ['place'], places: ['home'] },
			pinned: { home: 25 },
			group: 'Awaiting you',
			build: { state: 'built' }
		}
	],
	waysIn: [
		{
			id: 'goals',
			label: 'goals',
			scope: 'active goals',
			source: 'list',
			filter: { docType: 'goal', status: 'active' }
		},
		{
			id: 'tasks',
			label: 'in progress',
			scope: 'tasks in progress',
			source: 'list',
			filter: { docType: 'task', stage: 'in-progress' }
		},
		{
			id: 'sessions',
			label: 'sessions',
			scope: 'sessions, most recent first',
			source: 'list',
			filter: { docType: 'session' }
		}
	],
	vocabularies: [
		{
			id: 'create',
			doctypes: [
				{ doctype: 'task', defaults: undefined },
				{ doctype: 'goal', defaults: undefined },
				{ doctype: 'session', defaults: { date: TODAY } },
				{ doctype: 'research', defaults: { date: TODAY } },
				{ doctype: 'concept', defaults: undefined },
				{ doctype: 'decision', defaults: undefined }
			]
		}
	],
	skills: []
};

/** The loader's answer with the closures resolved, so the differential compares data only. */
const withoutClosures = (contribution: Contribution) => ({
	plugin: contribution.plugin,
	lenses: contribution.lenses.map((lens) => ({
		...lens,
		build: lens.build.state === 'built' ? { state: 'built' } : lens.build
	})),
	waysIn: contribution.waysIn,
	vocabularies: contribution.vocabularies.map((vocabulary) => ({
		id: vocabulary.id,
		doctypes: vocabulary.doctypes.map(({ doctype, defaults }) => ({
			doctype,
			defaults: defaults?.(TODAY)
		}))
	})),
	skills: contribution.skills
});

describe('the package loader', () => {
	it('loads the shipped temper-workflows package whole, nothing refused', () => {
		const { contributions, refusals } = loadContributions(packageWith(pluginManifestText()));
		expect(refusals).toEqual([]);
		expect(contributions).toHaveLength(1);
	});

	it('loads what temper-workflows.ts used to export, the component closures apart', () => {
		const { contributions, refusals } = loadContributions(packageWith(pluginManifestText()));
		expect(refusals).toEqual([]);
		expect(withoutClosures(contributions[0])).toEqual(wasTemperWorkflows);
	});

	it('refuses an unknown component, naming the package and the field path', () => {
		const lens = {
			id: 'temper-workflows/home-timeline',
			name: 'timeline',
			accepts: { kinds: ['place'], places: ['home'] },
			build: { state: 'built', component: 'home-timeline' }
		};
		const { contributions, refusals } = loadOne(withLens(lens));
		expect(contributions).toEqual([]);
		expect(refusals).toEqual([
			"refused the temper-workflows package: no such component 'home-timeline' at contributions.lenses[0].build.component"
		]);
	});

	it('refuses a lens carrying a plugin of its own — the loader stamps the package name', () => {
		const lens = {
			id: 'temper-workflows/home-handoff',
			name: 'latest handoff',
			plugin: 'someone-else',
			accepts: { kinds: ['place'], places: ['home'] },
			build: { state: 'built', component: 'home-handoff' },
			pinned: { home: 15 },
			group: 'Resume'
		};
		const { refusals } = loadOne(withLens(lens));
		expect(refusals[0]).toContain('contributions.lenses[0]');
	});

	it('refuses a lens id the package name does not namespace', () => {
		const lens = {
			id: 'practice/home-handoff',
			name: 'latest handoff',
			accepts: { kinds: ['place'], places: ['home'] },
			build: { state: 'built', component: 'home-handoff' }
		};
		const { refusals } = loadOne(withLens(lens));
		expect(refusals[0]).toBe(
			'refused the temper-workflows package: its lens id is not namespaced by the package name at contributions.lenses[0].id'
		);
	});

	it('refuses a lens that accepts an unknown subject kind', () => {
		const lens = {
			id: 'temper-workflows/home-handoff',
			name: 'latest handoff',
			accepts: { kinds: ['widget'], places: ['home'] },
			build: { state: 'built', component: 'home-handoff' }
		};
		const { refusals } = loadOne(withLens(lens));
		expect(refusals[0]).toContain('contributions.lenses[0].accepts.kinds');
	});

	it('refuses an unknown default kind', () => {
		const manifest = JSON.parse(pluginManifestText());
		manifest.contributions.vocabularies[0].doctypes[2].defaults = { date: 'tomorrow' };
		const { contributions, refusals } = loadOne(JSON.stringify(manifest));
		expect(contributions).toEqual([]);
		expect(refusals[0]).toContain('contributions.vocabularies[0].doctypes[2].defaults');
	});

	it('refuses a manifest that is not parseable JSON', () => {
		const { contributions, refusals } = loadOne('{ not json');
		expect(contributions).toEqual([]);
		expect(refusals[0]).toBe(
			'refused the temper-workflows package: its plugin.json is not parseable JSON at plugin.json'
		);
	});

	it('refuses a package with no plugin.json among its files', () => {
		const { refusals } = loadContributions([
			{ name: 'temper-workflows', files: [{ path: 'README', text: 'not the manifest' }] }
		]);
		expect(refusals[0]).toBe(
			'refused the temper-workflows package: its files carry no plugin.json at plugin.json'
		);
	});

	it('takes injected sources only: any name, any files, no disk, no repo path', () => {
		const { contributions, refusals } = loadContributions([
			{ name: 'a-package-anywhere', files: [{ path: 'anything.txt', text: 'x' }] }
		]);
		expect(contributions).toEqual([]);
		expect(refusals[0]).toContain('refused the a-package-anywhere package');
	});

	// --- closedness: every top-level shape refuses an extra key, and a bound lens is a
	// deliberate absence of the format — runtime state, never a manifest claim ---------------

	const withManifest = (apply: (manifest: Record<string, unknown>) => void): string => {
		const manifest = JSON.parse(pluginManifestText()) as Record<string, unknown>;
		apply(manifest);
		return JSON.stringify(manifest);
	};

	const refusesWith = (text: string, sentence: string) => {
		const { contributions, refusals } = loadOne(text);
		expect(contributions).toEqual([]);
		expect(refusals).toEqual([sentence]);
	};

	it('refuses a manifest carrying an extra key', () => {
		refusesWith(
			withManifest((m) => (m.shippedBy = 'someone')),
			// the manifest itself: zod answers the key, and there is no field path to name
			'refused the temper-workflows package: Unrecognized key: "shippedBy"'
		);
	});

	it('refuses contributions carrying an extra key', () => {
		refusesWith(
			withManifest((m) => ((m.contributions as Record<string, unknown>).pinned = true)),
			'refused the temper-workflows package: Unrecognized key: "pinned" at contributions'
		);
	});

	it('refuses a lens accepts carrying an extra key', () => {
		refusesWith(
			withManifest((m) => {
				const lens = (m.contributions as { lenses: Record<string, unknown>[] }).lenses[0];
				(lens.accepts as Record<string, unknown>).groups = [];
			}),
			'refused the temper-workflows package: Unrecognized key: "groups" at contributions.lenses[0].accepts'
		);
	});

	it('refuses a way-in filter carrying an extra key', () => {
		refusesWith(
			withManifest((m) => {
				const way = (m.contributions as { waysIn: { filter: Record<string, unknown> }[] })
					.waysIn[0];
				way.filter.plugin = 'core';
			}),
			'refused the temper-workflows package: Unrecognized key: "plugin" at contributions.waysIn[0].filter'
		);
	});

	it('refuses a vocabulary carrying an extra key', () => {
		refusesWith(
			withManifest((m) => {
				const vocabulary = (
					m.contributions as {
						vocabularies: Record<string, unknown>[];
					}
				).vocabularies[0];
				vocabulary.defaults = {};
			}),
			'refused the temper-workflows package: Unrecognized key: "defaults" at contributions.vocabularies[0]'
		);
	});

	it('refuses a lens whose build state is bound — bound is runtime state, not a manifest claim', () => {
		refusesWith(
			withManifest((m) => {
				(m.contributions as { lenses: Record<string, unknown>[] }).lenses[0].build = {
					state: 'bound',
					component: 'home-handoff'
				};
			}),
			"refused the temper-workflows package: Invalid discriminator value. Expected 'built' | 'unbuilt' at contributions.lenses[0].build.state"
		);
	});

	// --- duplicates: a name already claimed, an id used twice in one package -----------------

	it('refuses a package whose manifest name another package already claims, naming both', () => {
		const named = (manifestName: string): string => {
			const manifest = JSON.parse(pluginManifestText()) as { name: string };
			manifest.name = manifestName;
			return JSON.stringify(manifest);
		};
		const { contributions, refusals } = loadContributions([
			{ name: 'a-pack', files: [{ path: 'plugin.json', text: named('temper-workflows') }] },
			{ name: 'b-pack', files: [{ path: 'plugin.json', text: named('temper-workflows') }] }
		]);
		expect(contributions).toHaveLength(1);
		expect(refusals).toEqual([
			"refused the b-pack package: its manifest name 'temper-workflows' is already claimed by the a-pack package at manifest.name"
		]);
	});

	it('refuses a lens id the same package already uses', () => {
		const { contributions, refusals } = loadOne(
			withManifest((m) => {
				const lenses = (m.contributions as { lenses: Record<string, unknown>[] }).lenses;
				lenses[1].id = lenses[0].id;
			})
		);
		expect(contributions).toEqual([]);
		expect(refusals[0]).toContain(
			"duplicate lens id 'temper-workflows/home-handoff' in this package at contributions.lenses[1].id"
		);
	});

	it('refuses a way-in id the same package already uses', () => {
		const { contributions, refusals } = loadOne(
			withManifest((m) => {
				const waysIn = (m.contributions as { waysIn: Record<string, unknown>[] }).waysIn;
				waysIn[1].id = waysIn[0].id;
			})
		);
		expect(contributions).toEqual([]);
		expect(refusals[0]).toContain(
			"duplicate way-in id 'goals' in this package at contributions.waysIn[1].id"
		);
	});
});
