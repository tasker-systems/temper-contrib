/**
 * Core's contribution: the lenses the desktop ships with. Place lenses (home, settings, setup,
 * catalog) are core's own and a plugin never contributes one; a plugin may pin a section to home.
 * The table and graph lenses are bound: a Table filled by the core from a resource listing, and a
 * Graph filled from a graph read — a walk from one resource, or an entry read anchored at a
 * context. The shape and search lenses are named and not built: each lands with its own port, and
 * until then a tab opened on one says so. Core's vocabulary is the base create vocabulary:
 * temper's plain doctypes with no opinionated defaults — the arm that keeps creation working
 * where no plugin governs.
 */
import type { Contribution } from '../lenses';

export const core: Contribution = {
	plugin: 'core',
	lenses: [
		{
			id: 'core/home',
			name: 'home',
			plugin: 'core',
			accepts: { kinds: ['place'], places: ['home'] },
			build: { state: 'built', component: () => import('../lenses/HomeLens.svelte') }
		},
		// Home's sections: lenses pinned to home (ruling A). Resume, the agent's asks, Start and
		// Explore are core's; the workflow's readings of the work are temper-workflows'.
		{
			id: 'core/home-resume',
			name: 'resume',
			plugin: 'core',
			accepts: { kinds: ['place'], places: ['home'] },
			pinned: { home: 10 },
			group: 'Resume',
			build: { state: 'built', component: () => import('../lenses/home/ResumeSection.svelte') }
		},
		{
			id: 'core/home-asks',
			name: 'awaiting you',
			plugin: 'core',
			accepts: { kinds: ['place'], places: ['home'] },
			pinned: { home: 20 },
			group: 'Awaiting you',
			build: { state: 'built', component: () => import('../lenses/home/AsksSection.svelte') }
		},
		{
			id: 'core/home-start',
			name: 'start',
			plugin: 'core',
			accepts: { kinds: ['place'], places: ['home'] },
			pinned: { home: 30 },
			group: 'Start',
			build: { state: 'built', component: () => import('../lenses/home/StartSection.svelte') }
		},
		{
			id: 'core/home-explore',
			name: 'explore',
			plugin: 'core',
			accepts: { kinds: ['place'], places: ['home'] },
			pinned: { home: 40 },
			group: 'Explore',
			build: { state: 'built', component: () => import('../lenses/home/ExploreSection.svelte') }
		},
		{
			id: 'core/document',
			name: 'document',
			plugin: 'core',
			accepts: { kinds: ['resource'] },
			build: { state: 'built', component: () => import('../lenses/DocumentLens.svelte') }
		},
		{
			id: 'core/settings',
			name: 'settings',
			plugin: 'core',
			accepts: { kinds: ['place'], places: ['settings'] },
			build: { state: 'built', component: () => import('../lenses/SettingsLens.svelte') }
		},
		{
			id: 'core/setup',
			name: 'setup',
			plugin: 'core',
			accepts: { kinds: ['place'], places: ['setup'] },
			build: { state: 'built', component: () => import('../lenses/SetupLens.svelte') }
		},
		{
			id: 'core/catalog',
			name: 'catalog',
			plugin: 'core',
			accepts: { kinds: ['place'], places: ['catalog'] },
			build: { state: 'built', component: () => import('../lenses/CatalogLens.svelte') }
		},
		{
			id: 'core/presentation',
			name: 'presented view',
			plugin: 'core',
			accepts: { kinds: ['presentation'] },
			build: { state: 'built', component: () => import('../lenses/PresentedLens.svelte') }
		},
		{
			id: 'core/table',
			name: 'table',
			plugin: 'core',
			accepts: { kinds: ['query'] },
			build: {
				state: 'bound',
				spec: {
					root: 'table',
					elements: { table: { type: 'Table', props: {}, children: [] } }
				},
				binding: { element: 'table', read: 'resource-list' }
			}
		},
		{
			id: 'core/graph',
			name: 'graph',
			plugin: 'core',
			accepts: { kinds: ['neighbourhood', 'resource', 'query'], queryBy: ['context'] },
			build: {
				state: 'bound',
				spec: {
					root: 'graph',
					elements: { graph: { type: 'Graph', props: {}, children: [] } }
				},
				binding: { element: 'graph', read: 'graph' }
			}
		},
		{
			id: 'core/shape',
			name: 'shape',
			plugin: 'core',
			accepts: { kinds: ['query'], queryBy: ['context'] },
			build: { state: 'unbuilt', landsWith: 'the shape lens' }
		},
		{
			id: 'core/search',
			name: 'search',
			plugin: 'core',
			accepts: { kinds: ['query'], queryBy: ['text'] },
			build: { state: 'unbuilt', landsWith: 'the search lens' }
		}
	],
	waysIn: [
		{
			id: 'contexts',
			label: 'contexts',
			scope: 'of the contexts your temper credentials can see',
			source: 'contexts'
		},
		{
			id: 'recent',
			label: 'recent work',
			scope: 'recently updated resources',
			source: 'recent'
		}
	],
	vocabularies: [
		{
			id: 'create',
			base: true,
			doctypes: [
				{ doctype: 'task' },
				{ doctype: 'goal' },
				{ doctype: 'session' },
				{ doctype: 'research' },
				{ doctype: 'concept' },
				{ doctype: 'decision' }
			]
		}
	],
	skills: []
};
