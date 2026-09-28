/**
 * temper-workflows' contribution: the workflow's ways in — goals that are active, tasks in
 * progress, and recent sessions — each a bounded list whose rows open in the document lens.
 * Its lenses are home's sections that read the work (the latest handoff, what was recently
 * updated); the workflow's own lenses (the register, tasks by stage, a session timeline) are their
 * own builds and are not declared here, built or unbuilt.
 */
import type { Contribution } from '../lenses';

export const temperWorkflows: Contribution = {
	plugin: 'temper-workflows',
	lenses: [
		{
			id: 'temper-workflows/home-handoff',
			name: 'latest handoff',
			plugin: 'temper-workflows',
			accepts: { kinds: ['place'], places: ['home'] },
			pinned: { home: 15 },
			group: 'Resume',
			build: { state: 'built', component: () => import('../lenses/home/HandoffSection.svelte') }
		},
		{
			id: 'temper-workflows/home-recent',
			name: 'recently updated',
			plugin: 'temper-workflows',
			accepts: { kinds: ['place'], places: ['home'] },
			pinned: { home: 25 },
			group: 'Awaiting you',
			build: {
				state: 'unbuilt',
				landsWith: "home's Awaiting-you slice — what changed recently in the contexts you work in"
			}
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
	vocabularies: [],
	skills: []
};
