/**
 * Sample specs for the catalog page, and a fixture resolver used only when the page runs outside
 * the Tauri shell (a plain browser, a screenshot). The page says which resolver answered.
 */
import type { RefResolver, Resolution } from '$lib/refs';

export const GOAL = '01a0d873-59c9-72f0-a31f-23f0da5d8789';
export const GROUNDING = '01a0d874-33f3-7c62-bf7d-b31d9328dc50';
export const SESSION = '01a0df01-8764-7612-9a3e-cd8fc036849a';
export const TASK = '01a0df11-8bea-7242-bd1a-379ffb7e3206';
export const MISSING = '00000000-0000-7000-8000-000000000000';
export const SLOW = '01a0cf67-67f7-7983-ad15-eac2bccadf59';

const known: Record<string, Omit<Extract<Resolution, { state: 'resolved' }>, 'id' | 'state'>> = {
	[GOAL]: { title: 'Temper is worked natively from the desktop', docType: 'goal', contextRef: '+temper-dev/contrib', decoratedRef: GOAL },
	[GROUNDING]: { title: 'Grounding: temper-desktop as a native room over temper', docType: 'research', contextRef: '+temper-dev/contrib', decoratedRef: GROUNDING },
	[SESSION]: { title: 'Session: themes/ role contract built; component-library spec proposed', docType: 'session', contextRef: '+temper-dev/contrib', decoratedRef: SESSION },
	[TASK]: { title: 'Wire the theme contract into temper-desktop and build the foundation catalog', docType: 'task', contextRef: '+temper-dev/contrib', decoratedRef: TASK }
};

// Answers per ref rather than per batch, so the one ref held back to show the arriving state
// does not hold the others back with it.
export const fixtureResolver: RefResolver = {
	source: 'fixtures',
	resolve(id) {
		if (id === SLOW) return new Promise(() => {});
		const hit = known[id];
		return Promise.resolve<Resolution>(
			hit ? { state: 'resolved', id, ...hit } : { state: 'unresolved', id, reason: 'no resource at this reference' }
		);
	}
};

export function activitySpec(shown: number) {
	const ids = [SESSION, TASK, GROUNDING, GOAL];
	const rows = ids.slice(0, shown).map((id, i) => [`r${i}`, { type: 'ResourceRef', props: { id }, children: [] }]);
	return {
		root: 'list',
		elements: {
			list: {
				type: 'BoundedList',
				props: { total: 41, shown, scope: 'since you last engaged', label: 'activity', state: 'present', more: { step: 1 } },
				children: rows.map(([k]) => k),
				on: { more: { action: 'showMore' } }
			},
			...Object.fromEntries(rows)
		}
	};
}

export const refsSpec = {
	root: 'list',
	elements: {
		list: {
			type: 'BoundedList',
			props: { total: 3, shown: 3, scope: 'references in this note', label: 'references', state: 'present' },
			children: ['a', 'b', 'c']
		},
		a: { type: 'ResourceRef', props: { id: GOAL, titleHint: 'the desktop goal' }, children: [] },
		b: { type: 'ResourceRef', props: { id: SLOW, titleHint: 'Grounding: a desktop authoring surface' }, children: [] },
		c: { type: 'ResourceRef', props: { id: MISSING, titleHint: 'a resource that sounds real' }, children: [] }
	}
};

export const regionSpecs = (['arriving', 'empty', 'gave-up', 'failed'] as const).map((state) => ({
	root: 'r',
	elements: { r: { type: 'RegionState', props: { state, label: 'history' }, children: [] } }
}));

export const refusedSpec = {
	root: 'list',
	elements: {
		list: { type: 'BoundedList', props: { shown: 1, scope: 'in this context', label: 'sources', state: 'present', color: '#ff0000' }, children: ['x'] },
		x: { type: 'ReachIndicator', props: { level: 'none' }, children: [] }
	}
};
