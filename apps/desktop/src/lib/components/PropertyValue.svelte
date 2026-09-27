<script lang="ts">
	/**
	 * One property value. Ported from temper-ui's PropertyValue.svelte (tasker-systems/temper,
	 * packages/temper-ui/src/lib/components/vault/PropertyValue.svelte, at ee12cd5) by
	 * copy-with-citation, re-pointed at theme roles. A scalar renders inline; a list or object
	 * collapses to a summary and opens on request, so the set always reads as the key set.
	 */
	import { classifyValue } from '$lib/properties';
	import Self from './PropertyValue.svelte';

	let { value }: { value: unknown } = $props();

	let v = $derived(classifyValue(value));
	let open = $state(false);
</script>

{#if v.kind === 'scalar'}
	<span class="scalar">{v.text}</span>
{:else}
	<button class="toggle" aria-expanded={open} onclick={() => (open = !open)}>
		{open ? '⌄' : '›'} {v.summary}
	</button>
	{#if open}
		<div class="sub">
			{#if v.kind === 'object'}
				{#each v.entries as [k, child] (k)}
					<div class="row">
						<span class="k">{k}</span>
						<span class="v"><Self value={child} /></span>
					</div>
				{/each}
			{:else}
				{#each v.items as item, i (i)}
					<div class="item"><span class="i">{i}</span><Self value={item} /></div>
				{/each}
			{/if}
		</div>
	{/if}
{/if}

<style>
	.scalar {
		font: 0.75rem var(--tp-font-doing);
		color: var(--tp-text-muted);
		overflow-wrap: anywhere;
	}
	.toggle {
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		font: 0.75rem var(--tp-font-doing);
		color: var(--tp-accent);
	}
	.toggle:hover {
		color: var(--tp-text);
	}
	.sub {
		margin: 0.3rem 0 0.3rem 0.2rem;
		padding-left: 0.7rem;
		border-left: 1px solid var(--tp-accent-line-soft);
	}
	.row {
		display: grid;
		grid-template-columns: 7rem 1fr;
		gap: 0.5rem;
		padding: 0.1rem 0;
	}
	.k,
	.i {
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	.v {
		min-width: 0;
	}
	.item {
		padding: 0.1rem 0;
	}
	.item .i {
		margin-right: 0.45rem;
	}
</style>
