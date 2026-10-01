/**
 * One specimen per catalog component: its catalog `example` as the root element, with children
 * drawn from other components' examples where it holds any. The catalog lens renders these, so
 * every component is seen in the running app through the same gate an agent's view passes; a
 * test holds every specimen to passing it.
 */
import type { Spec } from '@json-render/core';
import source from './temper.catalog.json';

type Entry = { description: string; slots: string[]; example: Record<string, unknown> };
const components = source.components as Record<string, Entry>;

export type Specimen = { name: string; description: string; spec: Spec };

const example = (name: string) => structuredClone(components[name].example);
const leaf = (type: string, props: Record<string, unknown> = example(type)) => ({
	type,
	props,
	children: [] as string[]
});
const text = (t: string) => leaf('Text', { text: t, tone: 'muted' });

/** What each component that holds children holds in its specimen. */
function childrenOf(name: string): Record<string, ReturnType<typeof leaf>> {
	switch (name) {
		case 'BoundedList':
			return { row: leaf('ResourceRef') };
		case 'Stack':
			return {
				one: leaf('Tag'),
				two: leaf('Tag', { label: 'revision', tint: 'cat-3' }),
				three: leaf('Tag', { label: 'blocked', tint: 'danger' })
			};
		case 'Grid':
			return {
				one: leaf('Stat'),
				two: leaf('Stat', { label: 'chapters drafted', value: '3 of 5' }),
				three: leaf('Stat', {
					label: 'open asks',
					value: 2,
					delta: { value: '−1', direction: 'down', tone: 'success' }
				})
			};
		case 'Section':
			return { body: text('A Section on its own is a titled block.') };
		default:
			return {};
	}
}

function sectioned(name: string): Specimen['spec'] {
	const elements: Record<string, unknown> = {
		root: { type: name, props: example(name), children: ['first', 'second'] },
		first: {
			type: 'Section',
			props: { title: 'Characters', open: true },
			children: ['firstBody']
		},
		firstBody: text('Who is in the story, and how they stand to one another.'),
		second: { type: 'Section', props: { title: 'Settings' }, children: ['secondBody'] },
		secondBody: text('Where the story takes place, and when.')
	};
	return { root: 'root', elements } as Spec;
}

/**
 * Two graphs on one page, so the lens always draws more than one: the catalog's example, and a
 * force layout of a plugin's own vocabulary, tinted by categorical roles, with a node unconnected.
 */
function twoGraphs(): Specimen['spec'] {
	const vocabulary = {
		total: 6,
		scope: 'in this story',
		label: 'characters',
		state: 'present',
		layout: 'force',
		nodes: [
			{ id: 'mara', label: 'Mara', kind: 'character', tint: 'cat-1' },
			{ id: 'jun', label: 'Jun', kind: 'character', tint: 'cat-1' },
			{ id: 'harbour', label: 'The harbour', kind: 'setting', tint: 'cat-5' },
			{ id: 'storm', label: 'The storm', kind: 'scene', tint: 'cat-3' },
			{ id: 'letter', label: 'The letter', kind: 'object' },
			{ id: 'aunt', label: 'An aunt, never named', kind: 'character', tint: 'cat-1' }
		],
		edges: [
			{ source: 'mara', target: 'jun', label: 'sister of', direction: 'none' },
			{ source: 'mara', target: 'harbour', label: 'lives at' },
			{ source: 'storm', target: 'harbour', label: 'set at' },
			{ source: 'jun', target: 'letter', label: 'writes' }
		]
	};
	const elements: Record<string, unknown> = {
		root: { type: 'Stack', props: { gap: 'loose' }, children: ['first', 'second'] },
		first: leaf('Graph'),
		second: leaf('Graph', vocabulary)
	};
	return { root: 'root', elements } as Spec;
}

export const specimens: Specimen[] = Object.entries(components).map(([name, c]) => {
	if (name === 'Accordion' || name === 'Tabs')
		return { name, description: c.description, spec: sectioned(name) };
	if (name === 'Graph') return { name, description: c.description, spec: twoGraphs() };
	const held = childrenOf(name);
	const props = example(name);
	if (name === 'BoundedList') props.shown = Object.keys(held).length;
	const spec = {
		root: 'root',
		elements: { root: { type: name, props, children: Object.keys(held) }, ...held }
	} as Spec;
	return { name, description: c.description, spec };
});
