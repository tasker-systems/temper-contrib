/**
 * The Graph's geometry: where nodes settle, which captions can be drawn, how an edge ends at its
 * node. Ported from temper-ui's graph (`packages/temper-ui/src/lib/graph/`: `forceNeighborhood`,
 * `placeLabels`, `nodeRadius`), reshaped for a catalog component. Nothing here knows a doc type,
 * a home or a colour; the component decides those from its props.
 *
 * Everything is deterministic: the simulation starts from a ring in the order the nodes arrive
 * and runs a fixed number of ticks, and captions are placed in a fixed order. A view the reader
 * returns to draws the same picture twice.
 */
import {
	forceCenter,
	forceCollide,
	forceLink,
	forceManyBody,
	forceRadial,
	forceSimulation,
	forceX,
	forceY,
	type SimulationNodeDatum
} from 'd3-force';

export type GraphLayout = 'force' | 'radial';

export interface LayoutInput {
	id: string;
	/** In a radial layout, a core node settles at the centre and the rest ring it. */
	core?: boolean;
}

export interface Placed extends SimulationNodeDatum {
	id: string;
	degree: number;
	x: number;
	y: number;
}

/**
 * Every edge between one pair of nodes, drawn as one line. Edges are kept in the order they came,
 * oriented from `source` to `target`: an edge that runs the other way is `reversed`.
 */
export interface Joined<E> {
	edges: { edge: E; reversed: boolean }[];
	source: Placed;
	target: Placed;
}

/** The plane the simulation runs in. The drawing is fitted to where nodes land, not to this. */
const W = 640;
const H = 400;
const TICKS = 300;

/** A mark's radius: more connected, a little larger, and never past a bound. */
export const nodeRadius = (degree: number): number => 6 + Math.min(8, degree * 0.6);

/**
 * How many other carried nodes each node is joined to. Neighbours, not edges: two relations
 * between the same pair are one line, and a node joined only to itself has none.
 */
export function degrees(
	nodes: { id: string }[],
	edges: { source: string; target: string }[]
): Map<string, number> {
	const neighbours = new Map(nodes.map((n) => [n.id, new Set<string>()]));
	for (const e of edges) {
		if (e.source === e.target) continue;
		neighbours.get(e.source)?.add(e.target);
		neighbours.get(e.target)?.add(e.source);
	}
	return new Map(
		[...neighbours].map(([id, set]) => [
			id,
			[...set].filter((other) => neighbours.has(other)).length
		])
	);
}

/**
 * Settles the connected nodes. Nodes with no edge among those carried are not placed: a graph
 * lists them beneath its drawing, because a position for an unconnected node would claim a
 * relation that is not there. Edges between one pair are joined into one line. An edge joining a
 * node to itself has no line to draw; it is returned in `selfJoined` so the graph can say so.
 */
export function settle<E extends { source: string; target: string }>(
	input: LayoutInput[],
	edges: E[],
	layout: GraphLayout
): { nodes: Placed[]; edges: Joined<E>[]; selfJoined: E[]; unconnected: string[] } {
	const degree = degrees(input, edges);
	const connected = input.filter((n) => (degree.get(n.id) ?? 0) > 0);
	const count = Math.max(1, connected.length);
	const nodes: Placed[] = connected.map((n, i) => ({
		id: n.id,
		degree: degree.get(n.id) ?? 0,
		x: W / 2 + Math.cos((i / count) * 2 * Math.PI) * 120,
		y: H / 2 + Math.sin((i / count) * 2 * Math.PI) * 120
	}));
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const pairs = new Map<string, Joined<E>>();
	for (const edge of edges) {
		const source = byId.get(edge.source);
		const target = byId.get(edge.target);
		if (!source || !target || source === target) continue;
		const key = JSON.stringify([edge.source, edge.target].sort());
		const pair = pairs.get(key);
		if (pair) pair.edges.push({ edge, reversed: pair.source !== source });
		else pairs.set(key, { edges: [{ edge, reversed: false }], source, target });
	}
	const joined = [...pairs.values()];

	const core = new Set(input.filter((n) => n.core).map((n) => n.id));
	const sim = forceSimulation(nodes)
		.force(
			'link',
			forceLink(joined.map((j) => ({ source: j.source, target: j.target })))
				.distance(80)
				.strength(0.6)
		)
		.force('charge', forceManyBody().strength(-260).distanceMax(240))
		.force('center', forceCenter(W / 2, H / 2))
		// A weak pull to the middle keeps separate clusters near one another: the drawing is fitted
		// to where nodes land, and clusters left to drift apart would shrink every mark with it.
		.force('x', forceX(W / 2).strength(0.08))
		.force('y', forceY(H / 2).strength(0.08))
		.force(
			'collide',
			forceCollide<Placed>().radius((n) => nodeRadius(n.degree) + 6)
		)
		.stop();
	if (layout === 'radial') {
		const minDim = Math.min(W, H);
		sim.force(
			'radial',
			forceRadial<Placed>(
				(n) => (core.has(n.id) ? minDim * 0.06 : minDim * 0.44),
				W / 2,
				H / 2
			).strength(0.6)
		);
	}
	for (let i = 0; i < TICKS; i++) sim.tick();

	return {
		nodes,
		edges: joined,
		selfJoined: edges.filter((e) => e.source === e.target && degree.has(e.source)),
		unconnected: input.filter((n) => (degree.get(n.id) ?? 0) === 0).map((n) => n.id)
	};
}

export interface Box {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

const overlaps = (a: Box, b: Box): boolean =>
	a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

/** Truncate to `max` characters with a trailing ellipsis. */
export const truncate = (text: string, max: number): string =>
	[...text].length <= max ? text : `${[...text].slice(0, max - 1).join('')}…`;

export interface Caption {
	id: string;
	x: number;
	y: number;
	text: string;
}

export const CAPTION = { max: 24, charWidth: 5.4, lineHeight: 12, cap: 28, padding: 2 };

/**
 * Which captions can be drawn without landing on another caption or on another node's mark.
 * Greedy, most connected first, ties broken on id. A caption that would collide is dropped, not
 * nudged: a label moved off its node reads as belonging to whatever it landed near. Every node
 * is still drawn, carries its name as a tooltip, and is in the list beneath.
 */
export function placeCaptions(
	nodes: { id: string; x: number; y: number; degree: number; label: string }[]
): Caption[] {
	const o = CAPTION;
	const marks = new Map<string, Box>(
		nodes.map((n) => {
			const r = nodeRadius(n.degree) + o.padding;
			return [n.id, { x1: n.x - r, y1: n.y - r, x2: n.x + r, y2: n.y + r }];
		})
	);
	const ranked = [...nodes].sort(
		(a, b) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
	const taken: Box[] = [];
	const placed: Caption[] = [];
	for (const n of ranked) {
		if (placed.length >= o.max) break;
		const text = truncate(n.label, o.cap);
		const half = ([...text].length * o.charWidth) / 2;
		const baseline = n.y + nodeRadius(n.degree) + o.lineHeight;
		const box: Box = {
			x1: n.x - half - o.padding,
			y1: baseline - o.lineHeight * 0.75,
			x2: n.x + half + o.padding,
			y2: baseline + o.padding
		};
		const hitsAMark = [...marks].some(([id, b]) => id !== n.id && overlaps(box, b));
		if (hitsAMark || taken.some((b) => overlaps(box, b))) continue;
		taken.push(box);
		placed.push({ id: n.id, x: n.x, y: baseline, text });
	}
	return placed;
}

/**
 * The drawing's frame: every mark and caption, with a margin. The SVG's viewBox is set to it, so
 * the graph fills its column at any width rather than sitting in a fixed canvas.
 */
export function frame(nodes: Placed[], captions: Caption[], margin = 12): Box {
	if (nodes.length === 0) return { x1: 0, y1: 0, x2: W, y2: H };
	let box: Box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
	const grow = (b: Box) => {
		box = {
			x1: Math.min(box.x1, b.x1),
			y1: Math.min(box.y1, b.y1),
			x2: Math.max(box.x2, b.x2),
			y2: Math.max(box.y2, b.y2)
		};
	};
	for (const n of nodes) {
		const r = nodeRadius(n.degree);
		grow({ x1: n.x - r, y1: n.y - r, x2: n.x + r, y2: n.y + r });
	}
	for (const c of captions) {
		const half = ([...c.text].length * CAPTION.charWidth) / 2;
		grow({ x1: c.x - half, y1: c.y - CAPTION.lineHeight, x2: c.x + half, y2: c.y + 3 });
	}
	return { x1: box.x1 - margin, y1: box.y1 - margin, x2: box.x2 + margin, y2: box.y2 + margin };
}

/**
 * A pair's line, trimmed to the rims of its two marks, and an arrowhead at each end an edge
 * points to. Arrowheads are drawn as shapes rather than SVG markers, so a graph holds no ids and
 * any number of graphs share a page without one's markers answering for another's.
 */
export function edgeGeometry(
	source: Placed,
	target: Placed,
	ends: { atSource: boolean; atTarget: boolean }
): { x1: number; y1: number; x2: number; y2: number; heads: string[] } {
	const dx = target.x - source.x;
	const dy = target.y - source.y;
	const len = Math.hypot(dx, dy) || 1;
	const ux = dx / len;
	const uy = dy / len;
	const rs = nodeRadius(source.degree) + 1.5;
	const rt = nodeRadius(target.degree) + 1.5;
	const x1 = source.x + ux * rs;
	const y1 = source.y + uy * rs;
	const x2 = target.x - ux * rt;
	const y2 = target.y - uy * rt;
	const head = (tipX: number, tipY: number, dirX: number, dirY: number): string => {
		const size = 6;
		const bx = tipX - dirX * size;
		const by = tipY - dirY * size;
		const px = -dirY * size * 0.5;
		const py = dirX * size * 0.5;
		const f = (v: number) => v.toFixed(2);
		return `M${f(tipX)},${f(tipY)} L${f(bx + px)},${f(by + py)} L${f(bx - px)},${f(by - py)} Z`;
	};
	const heads = [
		...(ends.atTarget ? [head(x2, y2, ux, uy)] : []),
		...(ends.atSource ? [head(x1, y1, -ux, -uy)] : [])
	];
	return { x1, y1, x2, y2, heads };
}

export type EdgeKind = 'contains' | 'leads_to' | 'express' | 'near';

/**
 * An edge that carries what the answer holds of its relation. The drawing grammar reads only
 * these fields (ported from temper-ui's graph palette): colour by label, dash by label then
 * kind, width by weight, arrowheads by polarity with none for `near`.
 */
export interface Answered {
	/** The relation, as the corpus names it. */
	label?: string;
	edgeKind?: EdgeKind;
	polarity?: 'forward' | 'inverse';
	/**
	 * The relation's strength, drawn as the line's width. Absent draws the unweighted width,
	 * stated — never defaulted to 1, which is a real weight and would render a corpus whose
	 * every edge happened to be weak as genuinely, uniformly thin.
	 */
	weight?: number;
}

export type StrokeRole = 'structural' | 'derived' | 'contradicts';

/** An edge with no `edgeKind` draws as the structural default: solid, headed by its polarity. */
const kindOf = (edge: Answered): EdgeKind => edge.edgeKind ?? 'contains';

const KIND_DASH: Record<EdgeKind, string | null> = {
	contains: null,
	leads_to: '7 4',
	express: '1 4',
	near: '4 4'
};

/** Stroke for an edge whose weight is absent. Deliberately not 1 — see {@link Answered}. */
export const UNWEIGHTED_WIDTH = 1.4;

/** How one edge draws: its role (a `--tp-*` role in the component), dash, width, and heads. */
export interface Stroke {
	role: StrokeRole;
	dash: string | null;
	width: number;
	atSource: boolean;
	atTarget: boolean;
}

export function stroke(edge: Answered): Stroke {
	const role =
		edge.label === 'contradicts'
			? 'contradicts'
			: edge.label === 'derived_from'
				? 'derived'
				: 'structural';
	// The label dashes first: a `derived_from` line dashes whatever its kind.
	const dash = edge.label === 'derived_from' ? '7 4' : KIND_DASH[kindOf(edge)];
	const width = edge.weight == null ? UNWEIGHTED_WIDTH : Math.max(1, Math.min(5, edge.weight));
	// A `near` relation points both ways at once, so it heads neither end.
	const headed = kindOf(edge) !== 'near';
	const forward = (edge.polarity ?? 'forward') === 'forward';
	return { role, dash, width, atSource: headed && !forward, atTarget: headed && forward };
}

/** Where a pair's arrowheads go: at each end some edge between them points to. */
export function pairEnds<E extends Answered>(
	edges: { edge: E; reversed: boolean }[]
): { atSource: boolean; atTarget: boolean } {
	const ends = { atSource: false, atTarget: false };
	for (const { edge, reversed } of edges) {
		const s = stroke(edge);
		if (!s.atSource && !s.atTarget) continue;
		if (s.atTarget !== reversed) ends.atTarget = true;
		else ends.atSource = true;
	}
	return ends;
}

/**
 * How a pair's line is drawn when its edges differ: a contradiction is never hidden behind a
 * plainer relation, a line dashes only when every edge on it dashes — with the dash the first
 * dashing edge names — and it is never thinner than the heaviest relation on it.
 */
export function pairStroke<E extends Answered>(
	edges: { edge: E }[]
): { role: StrokeRole; dash: string | null; width: number } {
	const strokes = edges.map(({ edge }) => stroke(edge));
	const role = strokes.some((s) => s.role === 'contradicts')
		? 'contradicts'
		: strokes.every((s) => s.role === 'derived')
			? 'derived'
			: 'structural';
	const dash = strokes.every((s) => s.dash) ? strokes[0].dash : null;
	const width = Math.max(...strokes.map((s) => s.width));
	return { role, dash, width };
}
