<script lang="ts" module>
	export type Column = {
		key: string;
		header: string;
		kind: 'text' | 'number' | 'date' | 'resource' | 'category' | 'list';
		tints?: Record<string, Category>;
		sortable?: boolean;
	};
	export type Cell = string | number | null | string[];
	export type Sort = { key: string; order: 'asc' | 'desc' };
	export type Facet = {
		key: string;
		label: string;
		counts: { value: string; count: number }[];
		active?: string;
		unlisted?: number;
		filterable?: boolean;
	};
</script>

<script lang="ts">
	/**
	 * Rows under typed columns, inside the bounded envelope — a native `<table>`, so reading order,
	 * headers and selection are the platform's. A resource cell holding an id is a link; one that
	 * does not is shown as written, never as a link to nothing. A category cell is tinted through
	 * its column's `tints`; a value with no tint is shown untinted. A list cell is its values, each
	 * untinted.
	 *
	 * A table that is one page of its total says which rows it shows and what lies either side
	 * (`page`); the active order is marked on its column (`sort`); facets count the whole listing
	 * by a field. Paging and sorting are offered only when the host handles them (`onpage`,
	 * `onsort`), and so is narrowing: a `filterable` facet's values are controls only when the
	 * host handles them (`onfilter`) — the value in force is marked, and choosing it again widens
	 * back. A control that does nothing would overstate itself.
	 */
	import Bounded from '../Bounded.svelte';
	import type { Page } from '../omission';
	import type { RegionStateName } from '../RegionState.svelte';
	import ResourceRef from '../ResourceRef.svelte';
	import Tag, { type Category } from './Tag.svelte';

	let {
		total,
		scope,
		label,
		state,
		columns,
		rows,
		page,
		sort,
		facets = [],
		fieldsNotShown = 0,
		onpage,
		onsort,
		onfilter
	}: {
		total: number;
		scope: string;
		label: string;
		state: 'present' | RegionStateName;
		columns: Column[];
		rows: Record<string, Cell>[];
		page?: Page;
		sort?: Sort;
		facets?: Facet[];
		fieldsNotShown?: number;
		onpage?: (offset: number) => void;
		onsort?: (sort: Sort) => void;
		onfilter?: (key: string, value: string) => void;
	} = $props();

	const RESOURCE =
		/^([a-z0-9-]{0,120}-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
	const text = (cell: Cell): string =>
		cell === null || cell === undefined
			? ''
			: Array.isArray(cell)
				? cell.join(', ')
				: typeof cell === 'number'
					? cell.toLocaleString()
					: cell;
	const empty = (cell: Cell): boolean =>
		cell === null || cell === undefined || (Array.isArray(cell) && cell.length === 0);

	const ariaSort = (column: Column) =>
		sort?.key === column.key ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined;

	/** A column already in order turns round; another starts the way its values read best. */
	function nextSort(column: Column): Sort {
		if (sort?.key === column.key)
			return { key: column.key, order: sort.order === 'asc' ? 'desc' : 'asc' };
		return {
			key: column.key,
			order: column.kind === 'date' || column.kind === 'number' ? 'desc' : 'asc'
		};
	}

	const previous = $derived(page && page.offset > 0 ? Math.max(0, page.offset - page.size) : null);
	const next = $derived(page?.more ? page.offset + rows.length : null);
</script>

<Bounded {total} shown={rows.length} {scope} {label} {state} {page}>
	{#if facets.length}
		<dl class="facets" aria-label={`${label}, counted across the listing`}>
			{#each facets as facet (facet.key)}
				{@const narrow = onfilter && facet.filterable}
				<div class="facet">
					<dt class="t-label">{facet.label}</dt>
					<dd>
						{#each facet.counts as c, i (i)}
							{#if i > 0 && !narrow}<span class="sep" aria-hidden="true">·</span>{/if}
							{#if narrow}
								<button
									class="count"
									aria-pressed={facet.active === c.value ? 'true' : 'false'}
									onclick={() => onfilter?.(facet.key, c.value)}
								>
									{c.value} <span class="n">{c.count.toLocaleString()}</span>
								</button>
							{:else}
								<span class="count" aria-current={facet.active === c.value ? 'true' : undefined}
									>{c.value} <span class="n">{c.count.toLocaleString()}</span></span
								>
							{/if}
						{/each}
						{#if facet.unlisted}
							<span class="sep" aria-hidden="true">·</span>
							<span class="unlisted">{facet.unlisted} more not listed</span>
						{/if}
					</dd>
				</div>
			{/each}
		</dl>
	{/if}
	<div class="scroll">
		<table aria-label={label}>
			<thead>
				<tr>
					{#each columns as column (column.key)}
						<th scope="col" class={column.kind} aria-sort={ariaSort(column)}>
							{#if onsort && column.sortable}
								<button class="sort" onclick={() => onsort(nextSort(column))}>
									{column.header}{#if sort?.key === column.key}<span class="dir" aria-hidden="true"
											>{sort.order === 'asc' ? ' ↑' : ' ↓'}</span
										>{/if}
								</button>
							{:else}
								{column.header}{#if sort?.key === column.key}<span class="dir" aria-hidden="true"
										>{sort.order === 'asc' ? ' ↑' : ' ↓'}</span
									>{/if}
							{/if}
						</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each rows as row, i (i)}
					<tr>
						{#each columns as column (column.key)}
							{@const cell = row[column.key] ?? null}
							<td class={column.kind}>
								{#if empty(cell)}
									<span class="none" aria-label="none">—</span>
								{:else if column.kind === 'resource' && typeof cell === 'string' && RESOURCE.test(cell)}
									<ResourceRef id={cell} />
								{:else if column.kind === 'category'}
									<Tag label={text(cell)} tint={column.tints?.[text(cell)]} />
								{:else if column.kind === 'list' && Array.isArray(cell)}
									<span class="values">
										{#each cell as value, j (j)}<Tag label={value} />{/each}
									</span>
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
	{#if fieldsNotShown > 0}
		<p class="fields">
			{fieldsNotShown} more {fieldsNotShown === 1 ? 'field' : 'fields'} on these rows not drawn as columns.
		</p>
	{/if}
	{#if onpage && page && (previous !== null || next !== null)}
		<nav class="pager" aria-label={`pages of ${label}`}>
			<button
				class="ed-action"
				disabled={previous === null}
				onclick={() => previous !== null && onpage(previous)}>Previous page</button
			>
			<button
				class="ed-action"
				disabled={next === null}
				onclick={() => next !== null && onpage(next)}>Next page</button
			>
		</nav>
	{/if}
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
	th[aria-sort] {
		color: var(--tp-text);
	}
	.sort {
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		color: inherit;
		cursor: pointer;
	}
	.sort:hover,
	.sort:focus-visible {
		color: var(--tp-accent);
	}
	td {
		padding: 0.5rem 0.7rem 0.5rem 0;
		border-bottom: 1px solid var(--tp-rule);
		vertical-align: middle;
		/* Not `anywhere`: that lets a column shrink to one character and wrap a date per glyph. */
		overflow-wrap: break-word;
	}
	td.text {
		color: var(--tp-text);
	}
	.number {
		text-align: right;
		font-family: var(--tp-font-doing);
		font-variant-numeric: tabular-nums;
	}
	td.date {
		font-family: var(--tp-font-doing);
		font-size: 0.78rem;
		white-space: nowrap;
	}
	td.resource {
		max-width: 18rem;
	}
	/* Not `.list`: that is the cell's own class, and a cell must stay a table cell. */
	.values {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
	.none {
		color: var(--tp-text-faint);
	}
	.facets {
		display: grid;
		gap: 0.3rem;
		margin: 0 0 0.8rem;
	}
	.facet {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.2rem 0.6rem;
	}
	dt {
		margin: 0;
	}
	dd {
		margin: 0;
		font: 0.78rem var(--tp-font-doing);
		color: var(--tp-text-muted);
	}
	.count[aria-current] {
		color: var(--tp-text);
		font-weight: 600;
	}
	button.count {
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}
	.facet button.count:not(:first-child) {
		margin-left: 0.5rem;
	}
	.count[aria-pressed='true'] {
		color: var(--tp-text);
		font-weight: 600;
	}
	.count[aria-pressed='false']:hover,
	.count[aria-pressed='false']:focus-visible {
		color: var(--tp-accent);
	}
	.n {
		color: var(--tp-text-subtle);
		font-variant-numeric: tabular-nums;
	}
	.sep,
	.unlisted {
		color: var(--tp-text-faint);
	}
	.sep {
		margin: 0 0.15rem;
	}
	.fields {
		margin: 0;
		padding-top: 0.5rem;
		font: 0.78rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
	.pager {
		display: flex;
		gap: 0.5rem;
		padding-top: 0.6rem;
	}
</style>
