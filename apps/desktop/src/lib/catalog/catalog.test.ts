import { describe, expect, it } from 'vitest';
import { checkSpec, temperCatalog } from './catalog';

const REF = '01a0d873-59c9-72f0-a31f-23f0da5d8789';

function list(props: Record<string, unknown>, rows = 1) {
	const children = Array.from({ length: rows }, (_, i) => `r${i}`);
	const elements: Record<string, unknown> = {
		list: { type: 'BoundedList', props, children }
	};
	for (const c of children) elements[c] = { type: 'ResourceRef', props: { id: REF }, children: [] };
	return { root: 'list', elements };
}

const good = { total: 41, shown: 1, scope: 'since you last engaged', label: 'activity', state: 'present' };

describe('the temper catalog', () => {
	it('names exactly the foundation components', () => {
		expect(temperCatalog.componentNames.sort()).toEqual(['BoundedList', 'RegionState', 'ResourceRef']);
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
		const region = { root: 'a', elements: { a: { type: 'RegionState', props: { state: 'empty', label: 'history', tint: 'red' }, children: [] } } };
		expect(checkSpec(region).ok).toBe(false);
	});

	it('refuses a component outside the catalog', () => {
		const spec = { root: 'a', elements: { a: { type: 'ReachIndicator', props: { level: 'none' }, children: [] } } };
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
				list: { type: 'BoundedList', props: { shown: 1, scope: 's', label: 'l', state: 'present', color: '#f00' }, children: ['x'] },
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

	it('refuses a reference that is not a resource id', () => {
		const spec = { root: 'a', elements: { a: { type: 'ResourceRef', props: { id: 'https://example.com' }, children: [] } } };
		expect(checkSpec(spec).ok).toBe(false);
	});

	it('describes itself for an agent without naming any chrome', () => {
		const prompt = temperCatalog.prompt();
		expect(prompt).toContain('BoundedList');
		expect(prompt).not.toContain('ReachIndicator');
	});
});
