<script lang="ts">
	/**
	 * The sources recorded against the document's blocks, in block order. Sources are recorded
	 * only when a writer names them, so a document with none says so plainly — none recorded,
	 * not unknown, and not a statement about who wrote it (that is History's).
	 */
	import { PANEL_STEP, type Sources } from '$lib/document';
	import BoundedList from './BoundedList.svelte';
	import RegionState from './RegionState.svelte';
	import ResourceRef from './ResourceRef.svelte';

	let { sources }: { sources: Sources } = $props();

	let shown = $state(PANEL_STEP);
	const rows = $derived(sources.blocks.slice(0, shown));
</script>

{#if sources.blocks.length === 0}
	<RegionState
		state="empty"
		label="recorded sources"
		detail="Sources are recorded only when a writer names what a block was drawn from."
	/>
{:else}
	<BoundedList
		label="recorded sources"
		scope="blocks with recorded sources, in document order"
		state="present"
		total={sources.blocks.length}
		shown={rows.length}
		more={{ step: PANEL_STEP }}
		onmore={() => (shown += PANEL_STEP)}
	>
		{#each rows as block (block.blockSeq)}
			<div class="block">
				<span class="seq">block {block.blockSeq}</span>
				<ul>
					{#each block.sources as source, i (i)}
						<li>
							{#if source.kind === 'resource'}
								<ResourceRef id={source.sourceId} />
							{:else if source.uri}
								<span class="uri">{source.uri}</span>
							{:else}
								<span class="uri">{source.kind} · {source.sourceId.slice(0, 8)}</span>
							{/if}
							{#if source.carried}<span class="carried">carried forward</span>{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</BoundedList>
{/if}

<style>
	.block {
		display: grid;
		grid-template-columns: 5rem 1fr;
		gap: 0.6rem;
		min-width: 0;
	}
	.seq,
	.carried {
		font: 0.6rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-label);
		text-transform: uppercase;
		color: var(--tp-text-subtle);
	}
	ul {
		display: grid;
		gap: 0.3rem;
		margin: 0;
		padding: 0;
		min-width: 0;
		list-style: none;
	}
	li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}
	.uri {
		overflow-wrap: anywhere;
		font: 0.75rem var(--tp-font-doing);
		color: var(--tp-text-muted);
	}
</style>
