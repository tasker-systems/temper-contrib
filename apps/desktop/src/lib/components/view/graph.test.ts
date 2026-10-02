import { describe, expect, it } from 'vitest';
import {
	degrees,
	edgeGeometry,
	frame,
	pairEnds,
	pairStroke,
	placeCaptions,
	settle,
	stroke,
	UNWEIGHTED_WIDTH
} from './graph';

const nodes = ['a', 'b', 'c', 'd', 'loner'].map((id) => ({ id, core: id === 'a' }));
const edges = [
	{ source: 'a', target: 'b' },
	{ source: 'a', target: 'c' },
	{ source: 'c', target: 'd' },
	{ source: 'a', target: 'ghost' },
	{ source: 'd', target: 'd' }
];

describe('the graph geometry', () => {
	it('counts neighbours among carried nodes, never a self-join or a repeated pair', () => {
		const repeated = [...edges, { source: 'b', target: 'a' }, { source: 'a', target: 'b' }];
		expect(Object.fromEntries(degrees(nodes, repeated))).toEqual({
			a: 2,
			b: 1,
			c: 2,
			d: 1,
			loner: 0
		});
	});

	it('places the connected nodes and lists the unconnected ones instead', () => {
		const g = settle(nodes, edges, 'force');
		expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(g.unconnected).toEqual(['loner']);
		expect(g.edges).toHaveLength(3);
		expect(g.selfJoined).toEqual([{ source: 'd', target: 'd' }]);
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
		const fwd = edgeGeometry(s, t, { atSource: false, atTarget: true });
		expect(fwd.x1).toBeGreaterThan(0);
		expect(fwd.x2).toBeLessThan(100);
		expect(fwd.heads).toHaveLength(1);
		expect(edgeGeometry(s, t, { atSource: false, atTarget: false }).heads).toHaveLength(0);
	});

	it('draws a repeated pair once, with every edge on it', () => {
		const g = settle(
			[{ id: 'a' }, { id: 'b' }],
			[
				{ source: 'a', target: 'b', edgeKind: 'leads_to' as const },
				{ source: 'b', target: 'a', label: 'contradicts', edgeKind: 'express' as const }
			],
			'force'
		);
		expect(g.edges).toHaveLength(1);
		const pair = g.edges[0];
		expect(pair.edges.map((e) => e.reversed)).toEqual([false, true]);
		expect(pairEnds(pair.edges)).toEqual({ atSource: true, atTarget: true });
		expect(pairStroke(pair.edges).role).toBe('contradicts');
		expect(pairStroke([{ edge: { label: 'derived_from' } }, { edge: {} }])).toEqual({
			role: 'structural',
			dash: null,
			width: UNWEIGHTED_WIDTH
		});
		expect(pairEnds([{ edge: { edgeKind: 'near' as const }, reversed: false }])).toEqual({
			atSource: false,
			atTarget: false
		});
	});

	it('reads the drawing grammar from the relation it carries', () => {
		// A `derived_from` label colours and dashes first, whatever the kind says.
		expect(stroke({ label: 'derived_from', edgeKind: 'express' })).toMatchObject({
			role: 'derived',
			dash: '7 4'
		});
		expect(stroke({ label: 'contradicts' }).role).toBe('contradicts');
		// Otherwise the dash is the kind's.
		expect(stroke({}).dash).toBeNull();
		expect(stroke({ edgeKind: 'leads_to' }).dash).toBe('7 4');
		expect(stroke({ edgeKind: 'express' }).dash).toBe('1 4');
		expect(stroke({ edgeKind: 'near' }).dash).toBe('4 4');
		// Weight spans the schema's 0..1 across the width's 1..5; absent, the unweighted width
		// is stated, not defaulted.
		expect(stroke({}).width).toBe(UNWEIGHTED_WIDTH);
		expect(stroke({ weight: 0 }).width).toBe(1);
		expect(stroke({ weight: 0.2 }).width).toBe(1.8);
		expect(stroke({ weight: 1 }).width).toBe(5);
		// Arrowheads follow polarity; a `near` relation heads neither end.
		expect(stroke({})).toMatchObject({ atSource: false, atTarget: true });
		expect(stroke({ polarity: 'inverse' })).toMatchObject({ atSource: true, atTarget: false });
		expect(stroke({ edgeKind: 'near' })).toMatchObject({ atSource: false, atTarget: false });
	});

	it('draws a pair of dashing edges dashed, and never thinner than its heaviest relation', () => {
		const dashed = pairStroke([
			{ edge: { edgeKind: 'leads_to' as const, weight: 0.5 } },
			{ edge: { edgeKind: 'near' as const } }
		]);
		expect(dashed.dash).toBe('7 4');
		expect(dashed.width).toBe(3);
	});

	it('keeps separate clusters near enough to read', () => {
		const pairs = Array.from({ length: 20 }, (_, i) => [`p${i}a`, `p${i}b`]);
		const g = settle(
			pairs.flat().map((id) => ({ id })),
			pairs.map(([source, target]) => ({ source, target })),
			'force'
		);
		const f = frame(g.nodes, []);
		expect(Math.max(f.x2 - f.x1, f.y2 - f.y1)).toBeLessThan(800);
	});
});
