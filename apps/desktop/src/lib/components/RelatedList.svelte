<script lang="ts">
	/**
	 * The document's neighbourhood: every resource one hop away, strongest joining edge first.
	 * Each neighbour opens in this tab, and the way out walks back along the tab's trail.
	 * Titles, types and excerpts are what temper's graph read returned — never typed here.
	 */
	import { PANEL_STEP, type Related, roomHref } from '$lib/document';
	import BoundedList from './BoundedList.svelte';

	let { related }: { related: Related } = $props();

	let shown = $state(PANEL_STEP);
	const rows = $derived(related.neighbours.slice(0, shown));
</script>

<BoundedList
	label="related resources"
	scope="resources one step away, strongest connection first"
	state="present"
	total={related.total}
	shown={rows.length}
	more={{ step: PANEL_STEP }}
	onmore={() => (shown += PANEL_STEP)}
>
	{#each rows as n (n.id)}
		<a class="neighbour" href={roomHref(n.id)}>
			<span class="head">
				{#if n.docType}<span class="type">{n.docType}</span>{/if}
				<span class="title">{n.title}</span>
			</span>
			{#if n.via.length}<span class="via">{n.via.join(' · ')}</span>{/if}
			{#if n.excerpt}<span class="excerpt">{n.excerpt}</span>{/if}
		</a>
	{/each}
</BoundedList>

<style>
	.neighbour {
		display: grid;
		gap: 0.15rem;
		min-width: 0;
		text-decoration: none;
		color: inherit;
	}
	.head {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}
	.type,
	.via {
		flex: none;
		font: 0.6rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-label);
		text-transform: uppercase;
		color: var(--tp-text-subtle);
	}
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: italic 0.88rem var(--tp-font-reading);
		color: var(--tp-text);
	}
	.neighbour:hover .title {
		color: var(--tp-accent);
	}
	.excerpt {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-size: 0.8rem;
		color: var(--tp-text-subtle);
	}
</style>
