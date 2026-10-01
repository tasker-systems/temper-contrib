<script lang="ts" module>
	import type { EdgeKind } from './graph';
	import type { Tint } from './Tag.svelte';

	export type DocTypeRole =
		| 'doctype-research'
		| 'doctype-task'
		| 'doctype-session'
		| 'doctype-concept'
		| 'doctype-goal'
		| 'doctype-decision'
		| 'doctype-memory';

	export type GraphNode = {
		id: string;
		label: string;
		kind?: string;
		tint?: DocTypeRole | Tint;
		ref?: string;
		core?: boolean;
		/** The node's edge count across the whole visible corpus, named beside the in-view degree. */
		corpusDegree?: number;
		excerpt?: string;
		stage?: string;
		updated?: string;
		/** Where the node is homed: the anchor's words, or its bare id when unmatched. */
		home?: string;
		homeKind?: 'context' | 'cogmap';
	};

	export type GraphEdge = {
		source: string;
		target: string;
		label?: string;
		edgeKind?: EdgeKind;
		polarity?: 'forward' | 'inverse';
		weight?: number;
	};
</script>

<script lang="ts">
	/**
	 * Nodes and the edges between them, read-only, inside the bounded envelope. Ported from
	 * temper-ui's graph canvas: its deterministic force layout, collision-aware captions, mark and
	 * edge grammar, and its rule that what is not connected is listed beneath the drawing rather
	 * than drawn in it, since a position there would claim a relation that is not there.
	 *
	 * Reshaped for the catalog. Every colour is a role, set through `data-tint` and classes, never
	 * a literal and never a style attribute. Arrowheads are shapes rather than SVG markers, so a
	 * graph holds no ids and any number share a page. The drawing is fitted to where its nodes
	 * land, so it fills its column at any width, and a larger drawing gets a taller canvas, within
	 * bounds (set through a `style:` directive, which the CSP admits). There is no pan or zoom: a
	 * bounded glance does not need one, and a camera would take the wheel from the page it sits in.
	 *
	 * Edges between one pair share a line, with every relation in its tooltip and in the list. An
	 * edge joining a node to itself has no line, and is named beneath the drawing.
	 *
	 * The marks are not links: an SVG anchor is not the anchor the shell follows. Every node is in
	 * the list beneath, and a node with a `ref` is a link there. The legend pairs each tint with
	 * its kind, so colour never names a node alone.
	 */
	import Bounded from '../Bounded.svelte';
	import type { RegionStateName } from '../RegionState.svelte';
	import ResourceRef from '../ResourceRef.svelte';
	import {
		edgeGeometry,
		frame,
		type GraphLayout,
		nodeRadius,
		pairEnds,
		pairStroke,
		placeCaptions,
		settle
	} from './graph';
	import './tints.css';

	let {
		total,
		scope,
		label,
		state,
		layout = 'force',
		nodes,
		edges
	}: {
		total: number;
		scope: string;
		label: string;
		state: 'present' | RegionStateName;
		layout?: GraphLayout;
		nodes: GraphNode[];
		edges: GraphEdge[];
	} = $props();

	const byId = $derived(new Map(nodes.map((n) => [n.id, n])));
	const nameOf = (id: string) => byId.get(id)?.label ?? id;
	const settled = $derived(settle(nodes, edges, layout));
	const marks = $derived(
		settled.nodes.map((p) => ({
			...p,
			node: byId.get(p.id) as GraphNode,
			r: nodeRadius(p.degree)
		}))
	);
	const captions = $derived(
		placeCaptions(
			marks.map((m) => ({ id: m.id, x: m.x, y: m.y, degree: m.degree, label: m.node.label }))
		)
	);
	const box = $derived(frame(settled.nodes, captions));
	const viewBox = $derived(`${box.x1} ${box.y1} ${box.x2 - box.x1} ${box.y2 - box.y1}`);
	// A larger drawing gets a taller canvas, within bounds, so its marks and captions stay legible.
	const height = $derived(`${Math.min(40, Math.max(20, ((box.y2 - box.y1) * 0.75) / 16))}rem`);
	const unconnected = $derived(settled.unconnected.map((id) => byId.get(id) as GraphNode));

	/** Each kind of node the drawing shows, with its tint: the word beside the colour. */
	const legend = $derived(
		[...new Map(
			marks
				.filter((m) => m.node.kind)
				.map((m) => [`${m.node.tint ?? 'none'}|${m.node.kind}`, m.node])
		).values()]
	);

	/** A relation, as read from one end: which way it points, what it is, and the other node. */
	const phrase = (edge: GraphEdge, from: 'source' | 'target') => {
		const other = nameOf(from === 'source' ? edge.target : edge.source);
		// A `near` relation points both ways at once, so it reads with no arrow at all.
		const arrow =
			edge.edgeKind === 'near'
				? '—'
				: ((edge.polarity ?? 'forward') === 'forward') === (from === 'source')
					? '→'
					: '←';
		return `${arrow} ${edge.label ?? 'joined'}: ${other}`;
	};

	/** Who a drawn node is joined to, in words, for the list beneath. */
	const joins = $derived.by(() => {
		const out = new Map<string, string[]>();
		const add = (id: string, text: string) => out.set(id, [...(out.get(id) ?? []), text]);
		for (const pair of settled.edges)
			for (const { edge } of pair.edges) {
				add(edge.source, phrase(edge, 'source'));
				add(edge.target, phrase(edge, 'target'));
			}
		return out;
	});

	const tooltip = (n: GraphNode, inView?: number) =>
		[n.label, n.kind, ...words(n, inView)].filter(Boolean).join(' · ');

	/** What the corpus knows of a node, worded where it is present and absent where it is not. */
	const words = (n: GraphNode, inView?: number): string[] => {
		const out: string[] = [];
		if (n.excerpt) out.push(n.excerpt);
		if (n.stage) out.push(n.stage);
		if (n.updated) out.push(n.updated);
		if (n.home) out.push(n.homeKind ? `${n.home} (${n.homeKind})` : n.home);
		if (n.corpusDegree !== undefined)
			out.push(`${inView ?? 0} here of ${n.corpusDegree} in the corpus`);
		return out;
	};
	const relations = (pair: (typeof settled.edges)[number]) =>
		pair.edges.map(({ edge }) => phrase(edge, 'source').replace(/^\S+ /, '')).join('\n');
	const described = $derived(
		`${label}: ${marks.length} connected by ${settled.edges.length} lines` +
			(unconnected.length ? `; ${unconnected.length} not connected, listed beneath` : '')
	);
</script>

<Bounded {total} shown={nodes.length} {scope} {label} {state}>
	<figure class="graph">
		{#if marks.length > 0}
			<svg
				{viewBox}
				preserveAspectRatio="xMidYMid meet"
				role="img"
				aria-label={described}
				style:height
			>
			<!-- Lines first, so a mark is never hidden under a stroke. The line's dash and width are
			     the pair's own, as presentation attributes; its colour is its role, never a literal. -->
			{#each settled.edges as pair, i (i)}
				{@const g = edgeGeometry(pair.source, pair.target, pairEnds(pair.edges))}
				{@const s = pairStroke(pair.edges)}
				<g class="edge" data-role={s.role}>
					<title>{relations(pair)}</title>
					<line
						x1={g.x1}
						y1={g.y1}
						x2={g.x2}
						y2={g.y2}
						stroke-width={s.width}
						stroke-dasharray={s.dash}
					/>
					{#each g.heads as d (d)}
						<path class="head" {d} />
					{/each}
				</g>
			{/each}
			{#each marks as m (m.id)}
				<g class="node" data-tint={m.node.tint ?? 'none'}>
					<title>{tooltip(m.node, m.degree)}</title>
						{#if m.node.core && layout === 'radial'}
							<circle class="ring" cx={m.x} cy={m.y} r={m.r + 4} />
						{/if}
						<circle class="mark" cx={m.x} cy={m.y} r={m.r} />
					</g>
				{/each}
				<!-- Captions last: a caption drawn between the node passes would be covered by a
				     later mark, which is the collision placement exists to prevent. -->
				<g class="captions" aria-hidden="true">
					{#each captions as c (c.id)}
						<text x={c.x} y={c.y} text-anchor="middle">{c.text}</text>
					{/each}
				</g>
			</svg>
			{#if legend.length > 0}
				<figcaption class="legend">
					{#each legend as n (`${n.tint ?? 'none'}|${n.kind}`)}
						<span class="entry">
							<span class="dot" data-tint={n.tint ?? 'none'} aria-hidden="true"></span>
							<span class="kind">{n.kind}</span>
						</span>
					{/each}
				</figcaption>
			{/if}
		{:else if unconnected.length > 0}
			<p class="nothing">
				Nothing here is connected to anything else shown, so there is no shape to draw.
			</p>
		{/if}

		{#if settled.selfJoined.length > 0}
			<p class="caption">
				{settled.selfJoined.length === 1
					? '1 edge joins a node to itself, so it has no line:'
					: `${settled.selfJoined.length} edges join a node to itself, so they have no line:`}
				{settled.selfJoined.map((e) => `${nameOf(e.source)} (${e.label ?? 'joined'})`).join('; ')}
			</p>
		{/if}

		{#if unconnected.length > 0}
			<div class="unconnected">
				<p class="caption">
					{unconnected.length} not connected to anything shown, so not drawn:
				</p>
				<ul>
					{#each unconnected as n (n.id)}
						<li>
							<span class="dot" data-tint={n.tint ?? 'none'} aria-hidden="true"></span>
							{#if n.ref}
								<ResourceRef id={n.ref} titleHint={n.label} />
							{:else}
								<span class="name">{n.label}</span>
							{/if}
							{#if n.kind}<span class="kind">{n.kind}</span>{/if}
							{#each words(n, 0) as word (word)}
								<span class="word">{word}</span>
							{/each}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if marks.length > 0}
			<details class="listed">
				<summary>The {marks.length} drawn, listed</summary>
				<ul>
					{#each marks as m (m.id)}
						<li>
							<span class="dot" data-tint={m.node.tint ?? 'none'} aria-hidden="true"></span>
							{#if m.node.ref}
								<ResourceRef id={m.node.ref} titleHint={m.node.label} />
							{:else}
								<span class="name">{m.node.label}</span>
							{/if}
							{#if m.node.kind}<span class="kind">{m.node.kind}</span>{/if}
							{#each words(m.node, m.degree) as word (word)}
								<span class="word">{word}</span>
							{/each}
							<span class="joins">{(joins.get(m.id) ?? []).join('; ')}</span>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</figure>
</Bounded>

<style>
	.graph {
		margin: 0;
		min-width: 0;
	}
	svg {
		display: block;
		width: 100%;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 0.9rem;
		margin-top: 0.3rem;
	}
	.entry {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	/* A node's colour is its role, read from the shared tint mapping (tints.css); a node with no
	   tint is neutral. One custom property, read by the mark and every dot. */
	[data-tint] {
		--node: var(--tint, var(--tp-text-subtle));
	}

	.mark {
		fill: var(--node);
		stroke: var(--tp-ground);
		stroke-width: 1.5;
	}
	.ring {
		fill: none;
		stroke: var(--tp-text-muted);
		stroke-width: 1.5;
	}
	.edge line {
		stroke: var(--tp-text-subtle);
	}
	.edge .head {
		fill: var(--tp-text-subtle);
		stroke: none;
	}
	/* A line's colour is its role: the derivation bridge, a contradiction, or the structure.
	   Its dash and width ride the line as presentation attributes, one per pair. */
	.edge[data-role='derived'] line {
		stroke: var(--tp-accent);
	}
	.edge[data-role='derived'] .head {
		fill: var(--tp-accent);
	}
	.edge[data-role='contradicts'] line {
		stroke: var(--tp-danger);
	}
	.edge[data-role='contradicts'] .head {
		fill: var(--tp-danger);
	}
	.captions text {
		fill: var(--tp-text-muted);
		font: 10px var(--tp-font-doing);
		paint-order: stroke;
		stroke: var(--tp-ground);
		stroke-width: 3px;
		stroke-linejoin: round;
	}
	.nothing,
	.caption {
		margin: 0.4rem 0 0.2rem;
		font: 0.75rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	ul {
		margin: 0.2rem 0 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.15rem;
		font-size: 0.8rem;
		color: var(--tp-text-muted);
	}
	li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.dot {
		flex: none;
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: var(--node);
	}
	.name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.kind {
		flex: none;
		font: 0.65rem var(--tp-font-doing);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--tp-text-subtle);
	}
	.joins,
	.word {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.word {
		font-size: 0.75rem;
		color: var(--tp-text-subtle);
	}
	.joins {
		font-size: 0.75rem;
		color: var(--tp-text-subtle);
	}
	.listed {
		margin-top: 0.4rem;
	}
	summary {
		cursor: pointer;
		font: 0.75rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
</style>
