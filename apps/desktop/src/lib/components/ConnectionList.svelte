<script lang="ts">
	/**
	 * Every edge touching the document, inbound and outbound. Ported from temper-ui's
	 * EdgeList.svelte (tasker-systems/temper, packages/temper-ui/src/lib/components/vault/EdgeList.svelte,
	 * at ee12cd5) by copy-with-citation, re-pointed at theme roles and the bounded list.
	 *
	 * The relationship reads in the author's own words — the edge's label, verbatim — or not at
	 * all; the arrows are direction, not relationship. A resource peer is a reference into its
	 * own room; a blob peer has no room and stays inert.
	 */
	import { PANEL_STEP, type Connections } from '$lib/document';
	import BoundedList from './BoundedList.svelte';
	import ResourceRef from './ResourceRef.svelte';

	let { connections }: { connections: Connections } = $props();

	let shown = $state(PANEL_STEP);
	const rows = $derived(connections.edges.slice(0, shown));
</script>

<BoundedList
	label="connections"
	scope="connections, outgoing first"
	state="present"
	total={connections.total}
	shown={rows.length}
	more={{ step: PANEL_STEP }}
	onmore={() => (shown += PANEL_STEP)}
>
	{#each rows as edge (edge.edgeId)}
		<span class="edge">
			<span class="rel">
				{#if edge.label}{edge.direction === 'outgoing' ? '' : '← '}{edge.label}{edge.direction === 'outgoing'
						? ' →'
						: ''}{/if}
			</span>
			{#if edge.peerTable === 'kb_resources'}
				<ResourceRef
					id={edge.peerId}
					titleHint={edge.peerTitle}
				/>
			{:else}
				<span class="blob">blob · {edge.peerId.slice(0, 8)}</span>
			{/if}
		</span>
	{/each}
</BoundedList>

<style>
	.edge {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.6rem;
		min-width: 0;
	}
	.rel {
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	.blob {
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text-muted);
	}
</style>
