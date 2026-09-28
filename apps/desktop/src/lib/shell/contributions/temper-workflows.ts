/**
 * temper-workflows' contribution: the workflow's ways in — goals that are active, tasks in
 * progress, and recent sessions — each a bounded list whose rows open in the document lens.
 * Entries only: the workflow's own lenses (the register, tasks by stage, a session timeline) are
 * their own builds and are not declared here, built or unbuilt.
 */
import type { Contribution } from '../lenses';

export const temperWorkflows: Contribution = {
	plugin: 'temper-workflows',
	lenses: [],
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
