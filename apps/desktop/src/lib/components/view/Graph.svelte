<script lang="ts" module>
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
	};

	export type GraphEdge = {
		source: string;
		target: string;
		label?: string;
		direction?: 'forward' | 'inverse' | 'none';
		kind?: 'link' | 'derived' | 'contradicts';
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
	 * land, so it fills its column at any width. There is no pan or zoom: a bounded glance does
	 * not need one, and a camera would take the wheel from the page it sits in.
	 *
	 * The marks are not links: an SVG anchor is not the anchor the shell follows. Every node is in
	 * the list beneath, and a node with a `ref` is a link there. A mark's name and kind, and an
	 * edge's relation, are its tooltip.
	 */
	import Bounded from '../Bounded.svelte';
	import type { RegionStateName } from '../RegionState.svelte';
	import ResourceRef from '../ResourceRef.svelte';
	import { edgeGeometry, frame, nodeRadius, placeCaptions, settle, type GraphLayout } from './graph';

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
	const settled = $derived(settle(nodes, edges, layout));
	const marks = $derived(
		settled.nodes.map((p) => ({ ...p, node: byId.get(p.id) as GraphNode, r: nodeRadius(p.degree) }))
	);
	const captions = $derived(
		placeCaptions(marks.map((m) => ({ id: m.id, x: m.x, y: m.y, degree: m.degree, label: m.node.label })))
	);
	const box = $derived(frame(settled.nodes, captions));
	const viewBox = $derived(`${box.x1} ${box.y1} ${box.x2 - box.x1} ${box.y2 - box.y1}`);
	const unconnected = $derived(settled.unconnected.map((id) => byId.get(id) as GraphNode));

	/** Who a drawn node is joined to, in words, for the list beneath. */
	const joins = $derived.by(() => {
		const out = new Map<string, string[]>();
		for (const e of settled.edges) {
			const relation = e.edge.label ?? 'joined to';
			out.set(e.source.id, [...(out.get(e.source.id) ?? []), `${relation} ${byId.get(e.target.id)?.label}`]);
			out.set(e.target.id, [...(out.get(e.target.id) ?? []), `${relation} (from) ${byId.get(e.source.id)?.label}`]);
		}
		return out;
	});

	const tooltip = (n: GraphNode) => (n.kind ? `${n.label} · ${n.kind}` : n.label);
	const described = $derived(
		`${label}: ${marks.length} connected by ${settled.edges.length} edges` +
			(unconnected.length ? `; ${unconnected.length} not connected, listed beneath` : '')
	);
</script>

<Bounded {total} shown={nodes.length} {scope} {label} {state}>
	<figure class="graph">
		{#if marks.length > 0}
			<svg {viewBox} preserveAspectRatio="xMidYMid meet" role="img" aria-label={described}>
				<!-- Edges first, so a mark is never hidden under a stroke. -->
				{#each settled.edges as e, i (i)}
					{@const g = edgeGeometry(e.source, e.target, e.edge.direction ?? 'forward')}
					<g class="edge" data-kind={e.edge.kind ?? 'link'}>
						<title>{e.edge.label ?? 'joined'}</title>
						<line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />
						{#each g.heads as d (d)}
							<path class="head" {d} />
						{/each}
					</g>
				{/each}
				{#each marks as m (m.id)}
					<g class="node" data-tint={m.node.tint ?? 'none'}>
						<title>{tooltip(m.node)}</title>
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
		{:else}
			<p class="nothing">Nothing here is connected to anything else shown, so there is no shape to draw.</p>
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
							{#if n.ref}<ResourceRef id={n.ref} titleHint={n.label} />{:else}<span class="name">{n.label}</span>{/if}
							{#if n.kind}<span class="kind">{n.kind}</span>{/if}
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
							{#if m.node.ref}<ResourceRef id={m.node.ref} titleHint={m.node.label} />{:else}<span class="name">{m.node.label}</span>{/if}
							{#if m.node.kind}<span class="kind">{m.node.kind}</span>{/if}
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
		height: 20rem;
	}
	/* A node's colour is its role: one custom property, set by the tint, read by mark and dot. */
	[data-tint] {
		--node: var(--tp-text-subtle);
	}
	[data-tint='doctype-research'] { --node: var(--tp-doctype-research); }
	[data-tint='doctype-task'] { --node: var(--tp-doctype-task); }
	[data-tint='doctype-session'] { --node: var(--tp-doctype-session); }
	[data-tint='doctype-concept'] { --node: var(--tp-doctype-concept); }
	[data-tint='doctype-goal'] { --node: var(--tp-doctype-goal); }
	[data-tint='doctype-decision'] { --node: var(--tp-doctype-decision); }
	[data-tint='doctype-memory'] { --node: var(--tp-doctype-memory); }
	[data-tint='cat-1'] { --node: var(--tp-cat-1); }
	[data-tint='cat-2'] { --node: var(--tp-cat-2); }
	[data-tint='cat-3'] { --node: var(--tp-cat-3); }
	[data-tint='cat-4'] { --node: var(--tp-cat-4); }
	[data-tint='cat-5'] { --node: var(--tp-cat-5); }
	[data-tint='cat-6'] { --node: var(--tp-cat-6); }
	[data-tint='cat-7'] { --node: var(--tp-cat-7); }
	[data-tint='cat-8'] { --node: var(--tp-cat-8); }
	[data-tint='notice'] { --node: var(--tp-notice); }
	[data-tint='success'] { --node: var(--tp-success); }
	[data-tint='danger'] { --node: var(--tp-danger); }
	[data-tint='pending'] { --node: var(--tp-pending); }

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
		stroke-width: 1.4;
	}
	.edge .head {
		fill: var(--tp-text-subtle);
		stroke: none;
	}
	.edge[data-kind='derived'] line {
		stroke-dasharray: 6 4;
	}
	.edge[data-kind='contradicts'] line {
		stroke: var(--tp-danger);
	}
	.edge[data-kind='contradicts'] .head {
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
	.joins {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
