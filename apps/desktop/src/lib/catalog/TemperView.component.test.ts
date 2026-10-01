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
		const headers = [...container.querySelectorAll('th')].map((th) => th.textContent);
		expect(headers).toEqual(['Title', 'Status', 'Words']);
		expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
		expect(container.querySelector('td [data-tint="cat-4"]')?.textContent).toBe('complete');
		expect(container.textContent).toContain('2 of 12 stories in this context; 10 not shown.');
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
		const { container } = render(TemperView, { spec: one('Graph', graph) });
		expect(container.querySelector('[role="alert"]')).toBeNull();
		// Seven nodes are joined by an edge; the character sketch is joined to nothing.
		expect(container.querySelectorAll('svg .node')).toHaveLength(7);
		expect(container.querySelectorAll('svg .edge')).toHaveLength(6);
		expect(container.querySelector('svg')?.textContent).not.toContain('A character sketch');
		expect(container.querySelector('.unconnected')?.textContent).toContain('A character sketch');
		expect(container.querySelector('.unconnected')?.textContent).toContain('character');
		expect(container.textContent).toContain('8 of 9 around this goal; 1 not shown.');
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
