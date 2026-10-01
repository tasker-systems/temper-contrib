// The first-wave components rendered through the one gate, from the specs an agent or a lens
// would send. `invoke` is mocked so a ResourceRef resolves to nothing without Tauri.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TemperView from './TemperView.svelte';
import source from './temper.catalog.json';

type Components = Record<string, { example: Record<string, unknown> }>;
const example = (name: string) => structuredClone((source.components as Components)[name].example);
const one = (type: string, props: unknown, children: string[] = [], more = {}) => ({
	root: 'a',
	elements: { a: { type, props, children }, ...more }
});
const section = (title: string, text: string, open = false) => ({
	[`s-${title}`]: { type: 'Section', props: { title, open }, children: [`t-${title}`] },
	[`t-${title}`]: { type: 'Text', props: { text }, children: [] }
});

describe('the first-wave components through TemperView', () => {
	it('lays out heading, text, tag and stat in a stack and a grid', () => {
		const spec = {
			root: 's',
			elements: {
				s: { type: 'Stack', props: { gap: 'loose' }, children: ['h', 'g'] },
				h: { type: 'Heading', props: { text: 'This week', level: 1 }, children: [] },
				g: { type: 'Grid', props: { columns: 3 }, children: ['st', 'tg', 'tx'] },
				st: { type: 'Stat', props: example('Stat'), children: [] },
				tg: { type: 'Tag', props: example('Tag'), children: [] },
				tx: { type: 'Text', props: { text: '<b>as written</b>' }, children: [] }
			}
		};
		const { container } = render(TemperView, { spec });
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelector('h2')?.textContent).toBe('This week');
		expect(container.querySelector('.grid.cols-3')).not.toBeNull();
		expect(container.textContent).toContain('4,210');
		expect(container.querySelector('[data-tint="cat-2"]')?.textContent).toBe('draft');
		// Text is never markup.
		expect(container.querySelector('b')).toBeNull();
		expect(container.textContent).toContain('<b>as written</b>');
	});

	it('draws a table under its columns, tints a category, and says what it omits', () => {
		const { container } = render(TemperView, { spec: one('Table', example('Table')) });
		const headers = [...container.querySelectorAll('th')].map((th) => th.textContent?.trim());
		expect(headers).toEqual(['Title', 'Status', 'Words ↑', 'Tags']);
		expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
		expect(container.querySelector('td [data-tint="cat-4"]')?.textContent).toBe('complete');
		// A list cell is its values; an empty one reads as none.
		const tags = [...container.querySelectorAll('td.list .tag')].map((t) => t.textContent);
		expect(tags).toEqual(['coast', 'night']);
		expect(container.querySelectorAll('td.list .none')).toHaveLength(1);
		// One page of twelve: which rows, and what follows, from the page the answer gave.
		expect(container.textContent).toContain('1–2 of 12 stories in this context; 10 after it.');
		// The active order is marked on its column; facets count the whole listing.
		expect(container.querySelector('th[aria-sort="ascending"]')?.textContent).toContain('Words');
		expect(container.querySelector('.facets')?.textContent).toMatch(/draft\s*7.*complete\s*5/s);
	});

	it('draws a facet that lists one value twice, rather than dropping the table', () => {
		const props = {
			...example('Table'),
			facets: [
				{
					key: 'stage',
					label: 'Stage',
					counts: [
						{ value: 'x', count: 1 },
						{ value: 'x', count: 2 }
					]
				}
			]
		};
		const { container } = render(TemperView, { spec: one('Table', props) });
		expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
		expect(container.querySelectorAll('.facets .count')).toHaveLength(2);
	});

	it('offers paging and sorting only when the host handles them', () => {
		const bare = render(TemperView, { spec: one('Table', example('Table')) });
		expect(bare.container.querySelector('th button')).toBeNull();
		expect(bare.container.querySelector('nav')).toBeNull();
	});

	it('routes a page or a sort to the host, with the params the catalog declares', async () => {
		const page = vi.fn();
		const sort = vi.fn();
		const { container, getByRole } = render(TemperView, {
			spec: one('Table', example('Table')),
			actions: { 'Table.page': page, 'Table.sort': sort }
		});
		// Only sortable columns are controls.
		const controls = [...container.querySelectorAll('th button')].map((b) => b.textContent?.trim());
		expect(controls).toEqual(['Title', 'Words ↑']);
		await fireEvent.click(getByRole('button', { name: /Words/ }));
		expect(sort).toHaveBeenCalledWith({ key: 'words', order: 'desc' });
		await fireEvent.click(getByRole('button', { name: 'Title' }));
		expect(sort).toHaveBeenLastCalledWith({ key: 'title', order: 'asc' });
		expect((getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(
			true
		);
		await fireEvent.click(getByRole('button', { name: 'Next page' }));
		expect(page).toHaveBeenCalledWith({ offset: 2 });
	});

	it('refuses a handler for an action the catalog does not declare', () => {
		expect(() =>
			render(TemperView, {
				spec: one('Table', example('Table')),
				actions: { 'Table.filter': () => {} }
			})
		).toThrow(/does not declare: Table.filter/);
	});

	it('draws a timeline in order, and a table not present as its state', () => {
		const timeline = render(TemperView, { spec: one('Timeline', example('Timeline')) });
		const titles = [...timeline.container.querySelectorAll('.title')].map((p) => p.textContent);
		expect(titles).toEqual(['Grounding done', 'Rulings recorded']);
		expect(timeline.container.textContent).toContain('All 2 in this goal.');
		const arriving = render(TemperView, {
			spec: one('Table', { ...example('Table'), state: 'arriving', total: 0, rows: [] })
		});
		expect(arriving.container.querySelector('table')).toBeNull();
		expect(arriving.container.textContent).toContain('Loading stories');
	});

	it('draws a chart and says how many points it stands for', () => {
		const { container } = render(TemperView, { spec: one('Chart', example('Chart')) });
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelector('figure')?.getAttribute('aria-label')).toBe(
			'word counts: words by week'
		);
		expect(container.textContent).toContain('All 8 weekly word counts.');
	});

	it('shows one tab at a time, chosen by its section title', async () => {
		const spec = one('Tabs', { label: 'Story parts' }, ['s-One', 's-Two'], {
			...section('One', 'first panel'),
			...section('Two', 'second panel')
		});
		const { container, getByRole } = render(TemperView, { spec });
		const tabs = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim());
		expect(tabs).toEqual(['One', 'Two']);
		const visible = () =>
			[...container.querySelectorAll('[role="tabpanel"]')]
				.filter((p) => !p.hasAttribute('hidden'))
				.map((p) => p.textContent?.trim());
		expect(visible()).toEqual(['first panel']);
		await fireEvent.click(getByRole('tab', { name: 'Two' }));
		expect(visible()).toEqual(['second panel']);
	});

	it('opens the accordion sections a spec marks open, and a lone section is a titled block', () => {
		const spec = one('Accordion', { multiple: true }, ['s-One', 's-Two'], {
			...section('One', 'first body'),
			...section('Two', 'second body', true)
		});
		const { container } = render(TemperView, { spec });
		const triggers = [...container.querySelectorAll('button[data-state]')].map((b) => [
			b.textContent?.replace('›', '').trim(),
			b.getAttribute('data-state')
		]);
		expect(triggers).toEqual([
			['One', 'closed'],
			['Two', 'open']
		]);
		const lone = render(TemperView, {
			spec: { root: 's-Solo', elements: section('Solo', 'body') }
		});
		expect(lone.container.querySelector('section h4')?.textContent).toBe('Solo');
	});

	it('refuses tabs that hold something other than sections, rendering nothing of them', () => {
		const spec = one('Tabs', { label: 'x' }, ['t'], {
			t: { type: 'Text', props: { text: 'stray' }, children: [] }
		});
		const { container } = render(TemperView, { spec });
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			'holds a Text, but only Section'
		);
		expect(container.textContent).not.toContain('stray');
	});
});

describe('the graph through TemperView', () => {
	const graph = example('Graph');

	it('draws the connected nodes, lists the one with no edge, and says what it omits', () => {
		const props = {
			total: 9,
			scope: 'around this goal',
			label: 'neighbourhood',
			state: 'present',
			nodes: [
				{
					id: 'goal',
					label: 'Temper is worked from the desktop',
					kind: 'goal',
					tint: 'doctype-goal',
					core: true
				},
				{ id: 't1', label: 'Catalog: a read-only Graph', kind: 'task', tint: 'doctype-task' },
				{ id: 'x1', label: 'A character sketch', kind: 'character' }
			],
			edges: [{ source: 't1', target: 'goal', label: 'advances' }]
		};
		const { container } = render(TemperView, { spec: one('Graph', props) });
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelectorAll('svg .node')).toHaveLength(2);
		expect(container.querySelectorAll('svg .edge')).toHaveLength(1);
		expect(container.querySelector('svg')?.textContent).not.toContain('A character sketch');
		expect(container.querySelector('.unconnected')?.textContent).toContain('A character sketch');
		expect(container.querySelector('.unconnected')?.textContent).toContain('character');
		expect(container.textContent).toContain('3 of 9 around this goal; 6 not shown.');
	});

	it('carries what the corpus knows of a node in its tooltip and its entry', () => {
		const props = {
			total: 2,
			scope: 'here',
			label: 'family',
			state: 'present',
			nodes: [
				{
					id: 'mara',
					label: 'Mara',
					kind: 'character',
					excerpt: 'The elder sister.',
					stage: 'shipped',
					updated: '2026-09-30',
					home: '+temper-dev/contrib',
					homeKind: 'context',
					corpusDegree: 41
				},
				{ id: 'jun', label: 'Jun' }
			],
			edges: [{ source: 'jun', target: 'mara', label: 'writes to' }]
		};
		const { container } = render(TemperView, { spec: one('Graph', props) });
		expect(container.querySelector('svg .node title')?.textContent).toBe(
			'Mara · character · The elder sister. · shipped · 2026-09-30 · +temper-dev/contrib (context) · 1 here of 41 in the corpus'
		);
		const entry = [...container.querySelectorAll('.listed li')].find((li) =>
			li.querySelector('.name')?.textContent?.includes('Mara')
		);
		expect(entry?.textContent).toContain('The elder sister.');
		expect(entry?.textContent).toContain('shipped');
		expect(entry?.textContent).toContain('2026-09-30');
		expect(entry?.textContent).toContain('+temper-dev/contrib (context)');
		expect(entry?.textContent).toContain('1 here of 41 in the corpus');
	});

	it('derives the drawing grammar from the relation it carries', () => {
		const props = {
			total: 4,
			scope: 'here',
			label: 'relations',
			state: 'present',
			nodes: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
				{ id: 'c', label: 'C' },
				{ id: 'd', label: 'D' }
			],
			edges: [
				{ source: 'a', target: 'b', label: 'derived_from', edgeKind: 'express', weight: 0.5 },
				{ source: 'b', target: 'c', label: 'contradicts', edgeKind: 'leads_to' },
				{ source: 'c', target: 'd', edgeKind: 'near' },
				{ source: 'd', target: 'a', weight: 0.5 }
			]
		};
		const { container } = render(TemperView, { spec: one('Graph', props) });
		expect(container.querySelector('[role="alert"]')).toBeNull();
		// The label dashes first: a `derived_from` line dashes whatever its kind.
		const derived = container.querySelector('.edge[data-role="derived"] line');
		expect(derived?.getAttribute('stroke-dasharray')).toBe('7 4');
		expect(derived?.getAttribute('stroke-width')).toBe('1');
		expect(container.querySelector('.edge[data-role="contradicts"] line')).not.toBeNull();
		// A `near` relation dashes short and heads neither end, and draws unweighted, stated.
		const near = [...container.querySelectorAll('svg .edge')].find(
			(e) => e.querySelector('line')?.getAttribute('stroke-dasharray') === '4 4'
		);
		expect(near?.querySelectorAll('.head')).toHaveLength(0);
		expect(near?.querySelector('line')?.getAttribute('stroke-width')).toBe('1.4');
		// A weighted relation draws at its clamped width, never at the unweighted one.
		const weighted = [...container.querySelectorAll('svg .edge')].find(
			(e) => e.querySelector('line')?.getAttribute('stroke-dasharray') === null
		);
		expect(weighted?.querySelector('line')?.getAttribute('stroke-width')).toBe('1');
	});

	it('paints a node only through its role, and an untinted node neutral', () => {
		const { container } = render(TemperView, { spec: one('Graph', graph) });
		const tints = [...container.querySelectorAll('svg .node')].map((n) =>
			n.getAttribute('data-tint')
		);
		expect(tints).toContain('doctype-goal');
		expect(container.querySelector('.unconnected [data-tint]')?.getAttribute('data-tint')).toBe(
			'none'
		);
		for (const el of container.querySelectorAll('svg *'))
			for (const attr of ['fill', 'stroke', 'style'])
				expect(el.hasAttribute(attr), attr).toBe(false);
	});

	it('names each kind beside its colour in a legend', () => {
		const { container } = render(TemperView, { spec: one('Graph', graph) });
		const entries = [...container.querySelectorAll('.legend .entry')].map((e) => [
			e.querySelector('[data-tint]')?.getAttribute('data-tint'),
			e.textContent?.trim()
		]);
		expect(entries).toContainEqual(['doctype-goal', 'goal']);
		expect(entries).toContainEqual(['doctype-task', 'task']);
		// The unconnected character is listed, not drawn, so it is not in the drawing's legend.
		expect(entries.map(([, k]) => k)).not.toContain('character');
	});

	it('states a self-join, draws a repeated pair once, and reads each relation its own way', () => {
		const props = {
			total: 3,
			scope: 'here',
			label: 'family',
			state: 'present',
			nodes: [
				{ id: 'mara', label: 'Mara' },
				{ id: 'jun', label: 'Jun' },
				{ id: 'lone', label: 'Lone' }
			],
			edges: [
				{ source: 'mara', target: 'jun', label: 'sister of', edgeKind: 'near' },
				{ source: 'mara', target: 'jun', label: 'writes to' },
				{ source: 'lone', target: 'lone', label: 'haunts' }
			]
		};
		const { container } = render(TemperView, { spec: one('Graph', props) });
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelectorAll('svg .edge')).toHaveLength(1);
		expect(container.querySelectorAll('svg .edge .head')).toHaveLength(1);
		expect(container.textContent?.replace(/\s+/g, ' ')).toContain(
			'1 edge joins a node to itself, so it has no line: Lone (haunts)'
		);
		const jun = [...container.querySelectorAll('.listed li')].find(
			(li) => li.querySelector('.name')?.textContent === 'Jun'
		);
		expect(jun?.querySelector('.joins')?.textContent).toBe('— sister of: Mara; ← writes to: Mara');
	});

	it('says nothing about connection when it carries no nodes', () => {
		const { arm: _arm, bounds: _bounds, cut: _cut, ...empty } = graph;
		const props = { ...empty, nodes: [], edges: [] };
		const { container } = render(TemperView, { spec: one('Graph', props) });
		expect(container.textContent).toContain(
			'0 of 600 the most-connected in this context; 600 not shown.'
		);
		expect(container.querySelector('svg')).toBeNull();
		expect(container.textContent).not.toContain('not connected to anything shown');
	});

	it('draws two graphs on one page with no id for one to answer for the other', () => {
		const spec = {
			root: 's',
			elements: {
				s: { type: 'Stack', props: {}, children: ['a', 'b'] },
				a: { type: 'Graph', props: graph, children: [] },
				b: { type: 'Graph', props: { ...graph, layout: 'force' }, children: [] }
			}
		};
		const { container } = render(TemperView, { spec });
		expect(container.querySelectorAll('svg')).toHaveLength(2);
		expect(container.querySelectorAll('svg [id], svg marker')).toHaveLength(0);
		for (const svg of container.querySelectorAll('svg'))
			expect(svg.querySelectorAll('.edge .head').length).toBeGreaterThan(0);
	});
});

describe('the catalog lens', () => {
	it('renders a specimen of every component, none refused', async () => {
		const { default: CatalogLens } = await import('$lib/shell/lenses/CatalogLens.svelte');
		const tab = { setTitle: vi.fn(), open: vi.fn(), beforeLeave: vi.fn(() => () => {}) };
		const { container } = render(CatalogLens, {
			subject: { kind: 'place', place: 'catalog' },
			tab
		});
		const shown = [...container.querySelectorAll('[data-component]')].map((s) =>
			s.getAttribute('data-component')
		);
		expect(shown.sort()).toEqual(Object.keys(source.components).sort());
		expect(container.querySelector('.refused')).toBeNull();
		expect(tab.setTitle).toHaveBeenCalledWith('view catalog');
	});
});
