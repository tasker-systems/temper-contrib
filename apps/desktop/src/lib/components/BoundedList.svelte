<script lang="ts">
	/**
	 * A bounded list that says what it omits. The omission sentence is composed here from
	 * `total`, `shown` and `scope` so no author words it out of step with the numbers. When the
	 * list is not present, its state renders through RegionState and no rows do.
	 */
	import type { Snippet } from 'svelte';
	import RegionState, { type RegionStateName } from './RegionState.svelte';

	let {
		total,
		shown,
		scope,
		label,
		state,
		more,
		onmore,
		children
	}: {
		total: number;
		shown: number;
		scope: string;
		label: string;
		state: 'present' | RegionStateName;
		more?: { step: number } | null;
		onmore?: () => void;
		children?: Snippet;
	} = $props();

	const omitted = $derived(Math.max(0, total - shown));
	const sentence = $derived(
		omitted === 0
			? `All ${total} ${scope}.`
			: `${shown} of ${total} ${scope}; ${omitted} not shown.`
	);
</script>

{#if state === 'present' && total === 0}
	<RegionState state="empty" {label} />
{:else if state === 'present'}
	<div class="bounded">
		<div class="rows">
			{@render children?.()}
		</div>
		<p class="omits">
			{sentence}
			{#if more && omitted > 0}
				<button class="ed-action ed-action--primary" onclick={() => onmore?.()}>
					Show {Math.min(more.step, omitted)} more
				</button>
			{/if}
		</p>
	</div>
{:else}
	<RegionState {state} {label} />
{/if}

<style>
	.rows > :global(*) {
		display: flex;
		gap: 0.8rem;
		align-items: baseline;
		padding: 0.55rem 0;
		border-bottom: 1px solid var(--tp-rule);
		font-size: 0.85rem;
		color: var(--tp-text-muted);
	}
	.omits {
		margin: 0;
		padding-top: 0.6rem;
		font: italic 0.82rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
	.omits button {
		margin-left: 0.4rem;
		font-style: normal;
	}
</style>
