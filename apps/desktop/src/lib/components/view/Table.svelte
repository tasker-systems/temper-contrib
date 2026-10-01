<script lang="ts" module>
	export type Column = {
		key: string;
		header: string;
		kind: 'text' | 'number' | 'date' | 'resource' | 'category';
		tints?: Record<string, Category>;
	};
	export type Cell = string | number | null;
</script>

<script lang="ts">
	/**
	 * Rows under typed columns, inside the bounded envelope — a native `<table>`, so reading order,
	 * headers and selection are the platform's. A resource cell holding an id is a link; one that
	 * does not is shown as written, never as a link to nothing. A category cell is tinted through
	 * its column's `tints`; a value with no tint is shown untinted.
	 */
	import Bounded from '../Bounded.svelte';
	import type { RegionStateName } from '../RegionState.svelte';
	import ResourceRef from '../ResourceRef.svelte';
	import Tag, { type Category } from './Tag.svelte';

	let {
		total,
		scope,
		label,
		state,
		columns,
		rows
	}: {
		total: number;
		scope: string;
		label: string;
		state: 'present' | RegionStateName;
		columns: Column[];
		rows: Record<string, Cell>[];
	} = $props();

	const RESOURCE =
		/^([a-z0-9-]{0,120}-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
	const text = (cell: Cell): string =>
		cell === null || cell === undefined
			? ''
			: typeof cell === 'number'
				? cell.toLocaleString()
				: cell;
</script>

<Bounded {total} shown={rows.length} {scope} {label} {state}>
	<div class="scroll">
		<table aria-label={label}>
			<thead>
				<tr>
					{#each columns as column (column.key)}
						<th scope="col" class={column.kind}>{column.header}</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows as row, i (i)}
					<tr>
						{#each columns as column (column.key)}
							{@const cell = row[column.key] ?? null}
							<td class={column.kind}>
								{#if cell === null}
									<span class="none" aria-label="none">—</span>
								{:else if column.kind === 'resource' && typeof cell === 'string' && RESOURCE.test(cell)}
									<ResourceRef id={cell} />
								{:else if column.kind === 'category'}
									<Tag label={text(cell)} tint={column.tints?.[text(cell)]} />
								{:else}
									{text(cell)}
								{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</Bounded>

<style>
	.scroll {
		overflow-x: auto;
		min-width: 0;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
		color: var(--tp-text-muted);
	}
	th {
		text-align: left;
		padding: 0.4rem 0.7rem 0.4rem 0;
		border-bottom: 1px solid var(--tp-rule-strong);
		font: 500 0.62rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-label);
		text-transform: uppercase;
		color: var(--tp-text-subtle);
		white-space: nowrap;
	}
	td {
		padding: 0.5rem 0.7rem 0.5rem 0;
		border-bottom: 1px solid var(--tp-rule);
		vertical-align: middle;
		overflow-wrap: anywhere;
	}
	td.text {
		color: var(--tp-text);
	}
	.number {
		text-align: right;
		font-family: var(--tp-font-doing);
		font-variant-numeric: tabular-nums;
	}
	.date {
		font-family: var(--tp-font-doing);
		font-size: 0.78rem;
		white-space: nowrap;
	}
	td.resource {
		max-width: 18rem;
	}
	.none {
		color: var(--tp-text-faint);
	}
</style>
