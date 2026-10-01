import { describe, expect, it } from 'vitest';
import { degrees, edgeGeometry, frame, placeCaptions, settle } from './graph';

const nodes = ['a', 'b', 'c', 'd', 'loner'].map((id) => ({ id, core: id === 'a' }));
const edges = [
	{ source: 'a', target: 'b' },
	{ source: 'a', target: 'c' },
	{ source: 'c', target: 'd' },
	{ source: 'a', target: 'ghost' },
	{ source: 'd', target: 'd' }
];

describe('the graph geometry', () => {
	it('counts only edges between carried nodes, and no self-joins', () => {
		expect(Object.fromEntries(degrees(nodes, edges))).toEqual({ a: 2, b: 1, c: 2, d: 1, loner: 0 });
	});

	it('places the connected nodes and lists the unconnected ones instead', () => {
		const g = settle(nodes, edges, 'force');
		expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(g.unconnected).toEqual(['loner']);
		expect(g.edges).toHaveLength(3);
		for (const n of g.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
	});

	it('lands in the same place every time', () => {
		const place = () => settle(nodes, edges, 'radial').nodes.map((n) => [n.x, n.y]);
		expect(place()).toEqual(place());
	});

	it('pulls core nodes toward the centre in a radial layout', () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, core: i === 0 }));
		const star = many.slice(1).map((n) => ({ source: 'n0', target: n.id }));
		const g = settle(many, star, 'radial');
		const cx = g.nodes.reduce((s, n) => s + n.x, 0) / g.nodes.length;
		const cy = g.nodes.reduce((s, n) => s + n.y, 0) / g.nodes.length;
		const dist = (id: string) => {
			const n = g.nodes.find((m) => m.id === id);
			return n ? Math.hypot(n.x - cx, n.y - cy) : Number.NaN;
		};
		for (const n of many.slice(1)) expect(dist('n0')).toBeLessThan(dist(n.id));
	});

	it('drops a caption that would collide rather than moving it', () => {
		const captions = placeCaptions([
			{ id: 'a', x: 0, y: 0, degree: 3, label: 'First' },
			{ id: 'b', x: 2, y: 1, degree: 1, label: 'Second' }
		]);
		expect(captions.map((c) => c.id)).toEqual(['a']);
	});

	it('frames every mark and caption it draws', () => {
		const g = settle(nodes, edges, 'force');
		const f = frame(g.nodes, []);
		for (const n of g.nodes) {
			expect(n.x).toBeGreaterThan(f.x1);
			expect(n.x).toBeLessThan(f.x2);
		}
	});

	it('ends an edge at the rims and heads it only where it has a direction', () => {
		const s = { id: 's', degree: 0, x: 0, y: 0 };
		const t = { id: 't', degree: 0, x: 100, y: 0 };
		const fwd = edgeGeometry(s, t, 'forward');
		expect(fwd.x1).toBeGreaterThan(0);
		expect(fwd.x2).toBeLessThan(100);
		expect(fwd.heads).toHaveLength(1);
		expect(edgeGeometry(s, t, 'none').heads).toHaveLength(0);
	});
});
