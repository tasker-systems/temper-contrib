<script lang="ts" module>
	export type ChartSeries = {
		name: string;
		tint: Category;
		points: { x: string | number; y: number }[];
	};
</script>

<script lang="ts">
	/**
	 * A line, bar, area or scatter chart on LayerChart, inside the bounded envelope. Each series
	 * is painted with its categorical role directly (`--tp-cat-N`), never through LayerChart's
	 * palette; LayerChart's own surface variables are answered from contract roles below, so its
	 * axes, rules and tooltip restyle with the theme. Series overlap, except bars, which group:
	 * stacking would add values the author did not say add up.
	 */
	import { AreaChart, BarChart, LineChart, ScatterChart } from 'layerchart';
	import Bounded from '../Bounded.svelte';
	import type { RegionStateName } from '../RegionState.svelte';
	import type { Category } from './Tag.svelte';

	let {
		total,
		scope,
		label,
		state,
		kind,
		x,
		y,
		series
	}: {
		total: number;
		scope: string;
		label: string;
		state: 'present' | RegionStateName;
		kind: 'line' | 'bar' | 'area' | 'scatter';
		x: { label: string; kind: 'number' | 'date' | 'category' };
		y: { label: string; unit?: string };
		series: ChartSeries[];
	} = $props();

	const shown = $derived(series.reduce((n, s) => n + s.points.length, 0));
	const xOf = (v: string | number): string | number | Date =>
		x.kind === 'date' && typeof v === 'string' ? new Date(v) : v;

	// Bars group within a band, which needs one row per x carrying every series' value; the other
	// kinds draw each series from its own points, so series need not share their xs.
	const wide = $derived.by(() => {
		const rows = new Map<string, Record<string, unknown>>();
		series.forEach((s, i) => {
			for (const p of s.points) {
				const key = String(p.x);
				const row = rows.get(key) ?? { x: xOf(p.x) };
				row[`s${i}`] = p.y;
				rows.set(key, row);
			}
		});
		return [...rows.values()];
	});
	const keyed = $derived(
		series.map((s, i) => ({
			key: `s${i}`,
			label: s.name,
			color: `var(--tp-${s.tint})`,
			data: s.points.map((p) => ({ x: xOf(p.x), y: p.y }))
		}))
	);
	const grouped = $derived(keyed.map(({ data: _data, ...rest }) => rest));
	const legend = $derived(series.length > 1);
	const described = $derived(`${label}: ${y.label}${y.unit ? ` (${y.unit})` : ''} by ${x.label}`);
</script>

<Bounded {total} {shown} {scope} {label} {state}>
	<figure class="chart" aria-label={described}>
		<div class="plot">
			{#if kind === 'bar'}
				<BarChart data={wide} x="x" series={grouped} seriesLayout="group" {legend} />
			{:else if kind === 'line'}
				<LineChart x="x" y="y" series={keyed} {legend} />
			{:else if kind === 'area'}
				<AreaChart x="x" y="y" series={keyed} seriesLayout="overlap" {legend} />
			{:else}
				<ScatterChart x="x" y="y" series={keyed} {legend} />
			{/if}
		</div>
		<figcaption>{y.label}{y.unit ? ` (${y.unit})` : ''} by {x.label}</figcaption>
	</figure>
</Bounded>

<style>
	.chart {
		margin: 0;
		min-width: 0;
	}
	.plot {
		height: 15rem;
		min-width: 0;
		/* LayerChart sets its value axis's labels left of the plot's origin: room for them inside
		   the column, so they never hang past it. */
		padding-left: 2.5rem;
	}
	figcaption {
		margin-top: 0.4rem;
		font: 0.7rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	/* LayerChart's variables, answered from contract roles. The tooltip portals to <body>, so it
	   is reached globally; the names are LayerChart's, the values only ever roles. */
	.plot :global(.lc-root-container),
	:global(.lc-tooltip-root) {
		--color-primary: var(--tp-accent);
		--color-surface-100: var(--tp-surface-raised);
		--color-surface-200: var(--tp-surface);
		--color-surface-300: var(--tp-rule-strong);
		--color-surface-content: var(--tp-text-muted);
		--color-danger: var(--tp-danger);
		--color-success: var(--tp-success);
		--color-warning: var(--tp-notice);
		--color-info: var(--tp-accent);
		--color-secondary: var(--tp-text-subtle);
		font-family: var(--tp-font-doing);
		font-size: 0.7rem;
	}
	/* LayerChart draws its rules, grid and tooltip in colours mixed from its surface variables —
	   a value no theme states. Each is answered with a role instead. Its rules sit in a cascade
	   layer behind `:where()`, so these unlayered ones win without contesting specificity. */
	.plot :global(:is(.lc-axis-rule, .lc-axis-tick, .lc-rule-x-line, .lc-rule-y-line)),
	.plot :global(.lc-highlight-line) {
		--stroke-color: var(--tp-rule-strong);
	}
	.plot :global(:is(.lc-axis-grid, .lc-grid-x-rule, .lc-grid-y-rule)) {
		--stroke-color: var(--tp-rule);
	}
	/* A bar's default outline is literal black (drawn at zero width); a bar is its fill alone. */
	.plot :global(.lc-bars-bar) {
		stroke: none;
	}
	.plot :global(.lc-highlight-area) {
		--fill-color: var(--tp-accent-wash);
	}
	:global(.lc-tooltip-container[data-variant]) {
		background-color: var(--tp-surface-raised);
		color: var(--tp-text);
		border: 1px solid var(--tp-rule-strong);
		box-shadow: none;
		backdrop-filter: none;
	}
	:global(.lc-tooltip-container .label) {
		color: var(--tp-text-subtle);
	}
	:global(.lc-tooltip-header) {
		border-bottom-color: var(--tp-rule);
	}
	:global(.lc-tooltip-separator) {
		background-color: var(--tp-rule);
	}
</style>
