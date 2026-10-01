import { describe, expect, it } from 'vitest';
import { checkSpec, MAX_DEPTH, MAX_ELEMENTS, temperCatalog } from './catalog';
import fixtures from './spec-fixtures.json';
import { specimens } from './specimens';

const REF = '01a0d873-59c9-72f0-a31f-23f0da5d8789';

function list(props: Record<string, unknown>, rows = 1) {
	const children = Array.from({ length: rows }, (_, i) => `r${i}`);
	const elements: Record<string, unknown> = {
		list: { type: 'BoundedList', props, children }
	};
	for (const c of children) elements[c] = { type: 'ResourceRef', props: { id: REF }, children: [] };
	return { root: 'list', elements };
}

const good = {
	total: 41,
	shown: 1,
	scope: 'since you last engaged',
	label: 'activity',
	state: 'present'
};

describe('the temper catalog', () => {
	it('names exactly the foundation, first-wave and graph components', () => {
		expect(temperCatalog.componentNames.sort()).toEqual([
			'Accordion',
			'BoundedList',
			'Chart',
			'Graph',
			'Grid',
			'Heading',
			'RegionState',
			'ResourceRef',
			'Section',
			'Stack',
			'Stat',
			'Table',
			'Tabs',
			'Tag',
			'Text',
			'Timeline'
		]);
	});

	it('accepts a conforming spec', () => {
		const r = checkSpec(list(good));
		expect(r.ok, JSON.stringify(r)).toBe(true);
	});

	it('refuses a BoundedList that omits total', () => {
		const { total: _omitted, ...rest } = good;
		expect(checkSpec(list(rest)).ok).toBe(false);
	});

	it('refuses a colour prop on any component', () => {
		expect(checkSpec(list({ ...good, color: '#ff0000' })).ok).toBe(false);
		const region = {
			root: 'a',
			elements: {
				a: {
					type: 'RegionState',
					props: { state: 'empty', label: 'history', tint: 'red' },
					children: []
				}
			}
		};
		expect(checkSpec(region).ok).toBe(false);
	});

	it('refuses a component outside the catalog', () => {
		const spec = {
			root: 'a',
			elements: { a: { type: 'ReachIndicator', props: { level: 'none' }, children: [] } }
		};
		expect(checkSpec(spec).ok).toBe(false);
	});

	it('refuses a list that shows more than it stands for, or miscounts its rows', () => {
		expect(checkSpec(list({ ...good, total: 0, shown: 1 })).ok).toBe(false);
		expect(checkSpec(list({ ...good, shown: 2 }, 1)).ok).toBe(false);
	});

	it('refuses a child that does not exist, and a root that is not an element', () => {
		const orphan = list(good);
		(orphan.elements.list as { children: string[] }).children = ['nowhere'];
		expect(checkSpec(orphan).ok).toBe(false);
		expect(checkSpec({ ...list(good), root: 'missing' }).ok).toBe(false);
	});

	it('refuses a state binding in place of a literal prop', () => {
		expect(checkSpec(list({ ...good, total: { $state: '/count' } })).ok).toBe(false);
	});

	it('shows why json-render alone is not the gate: validate() admits what checkSpec refuses', () => {
		const { total: _omitted, ...rest } = good;
		expect(temperCatalog.validate(list(rest)).success).toBe(true);
		expect(checkSpec(list(rest)).ok).toBe(false);
	});

	it('lists every reason a spec is refused, not only the first', () => {
		const spec = {
			root: 'list',
			elements: {
				list: {
					type: 'BoundedList',
					props: { shown: 1, scope: 's', label: 'l', state: 'present', color: '#f00' },
					children: ['x']
				},
				x: { type: 'ReachIndicator', props: {}, children: [] }
			}
		};
		const r = checkSpec(spec);
		expect(r.ok).toBe(false);
		const text = r.ok ? '' : r.errors.join('\n');
		expect(text).toMatch(/type/);
		expect(text).toMatch(/total/);
		expect(text).toMatch(/color/);
	});

	it('refuses children that are not an array, answering rather than throwing', () => {
		for (const children of [5, {}, 'r']) {
			const r = checkSpec({
				root: 'r',
				elements: { r: { type: 'RegionState', props: { state: 'failed', label: 'x' }, children } }
			});
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors.some((e) => e.includes('children'))).toBe(true);
		}
	});

	// The spec is an agent's untrusted input: the shape is closed, lookups are own-key, and the
	// elements form one bounded tree. Each case below is an attack a looser gate admitted.
	const region = (children: unknown[] = []) => ({
		type: 'RegionState',
		props: { state: 'failed', label: 'x' },
		children
	});
	const refusedFor = (spec: unknown, fragment: string) => {
		const r = checkSpec(spec);
		expect(r.ok, JSON.stringify(r)).toBe(false);
		if (!r.ok) expect(r.errors.join('\n')).toContain(fragment);
	};

	it('refuses a cycle, and a child placed twice, rather than render without end', () => {
		const selfList = list(good);
		(selfList.elements.list as { children: string[] }).children = ['list'];
		refusedFor(selfList, 'already placed');
		// The fan-out that multiplies a render: two parents naming the same two children.
		refusedFor(
			{
				root: 'a',
				elements: { a: region(['b', 'c']), b: region(['d']), c: region(['d']), d: region() }
			},
			'"d" is already placed'
		);
	});

	it('refuses an element that root does not reach', () => {
		refusedFor({ root: 'a', elements: { a: region(), stray: region() } }, 'not reachable');
	});

	it('refuses a view past its bounds', () => {
		const many = Object.fromEntries(
			Array.from({ length: MAX_ELEMENTS + 1 }, (_, i) => [`e${i}`, region()])
		);
		refusedFor({ root: 'e0', elements: many }, `more than ${MAX_ELEMENTS}`);
		const chain = Object.fromEntries(
			Array.from({ length: MAX_DEPTH + 1 }, (_, i) => [
				`e${i}`,
				region(i < MAX_DEPTH ? [`e${i + 1}`] : [])
			])
		);
		refusedFor({ root: 'e0', elements: chain }, `deeper than ${MAX_DEPTH}`);
	});

	it('refuses bindings, handlers and state anywhere in the shape', () => {
		for (const [field, value] of [
			['on', { press: { action: 'setState' } }],
			['visible', { $state: '/secret' }],
			['watch', { '/x': { action: 'setState' } }],
			['repeat', { statePath: '/rows' }],
			['zzz', 1]
		] as const)
			refusedFor({ root: 'r', elements: { r: { ...region(), [field]: value } } }, `"${field}"`);
		refusedFor({ root: 'r', elements: { r: region() }, state: { secret: 1 } }, '"state"');
	});

	it('is satisfied by nothing inherited from Object.prototype, and never throws on it', () => {
		refusedFor(
			{ root: 'r', elements: { r: region(['toString']) } },
			'"toString" that does not exist'
		);
		refusedFor({ root: 'constructor', elements: { r: region() } }, 'root: "constructor"');
		refusedFor(
			JSON.parse(
				'{"root":"r","elements":{"r":{"type":"RegionState","props":{"state":"failed","label":"x"},"children":["__proto__"]},"__proto__":{"type":"RegionState","props":{"state":"failed","label":"x"},"children":[]}}}'
			),
			'reserved name'
		);
		for (const type of ['constructor', 'toString', '__proto__'])
			expect(() =>
				checkSpec({ root: 'r', elements: { r: { type, props: {}, children: [] } } })
			).not.toThrow();
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it('refuses a reference that is not a resource id', () => {
		const spec = {
			root: 'a',
			elements: { a: { type: 'ResourceRef', props: { id: 'https://example.com' }, children: [] } }
		};
		expect(checkSpec(spec).ok).toBe(false);
	});

	it('describes itself for an agent without naming any chrome', () => {
		const prompt = temperCatalog.prompt();
		expect(prompt).toContain('BoundedList');
		expect(prompt).not.toContain('ReachIndicator');
	});
});

// The corpus the core's own check (`src-tauri/src/spec_check.rs`) runs too: the two gates are
// written twice, so each case pins a verdict both must give.
describe('the shared spec corpus', () => {
	for (const c of fixtures.cases)
		it(`${c.ok ? 'passes' : 'refuses'} ${c.name}`, () => {
			const r = checkSpec(c.spec);
			expect(r.ok, JSON.stringify(r)).toBe(c.ok);
		});
});

describe('the catalog lens specimens', () => {
	it('has one for every component, and each passes the gate', () => {
		expect(specimens.map((s) => s.name).sort()).toEqual([...temperCatalog.componentNames].sort());
		for (const s of specimens)
			expect(checkSpec(s.spec), s.name).toEqual({ ok: true, spec: s.spec });
	});
});
