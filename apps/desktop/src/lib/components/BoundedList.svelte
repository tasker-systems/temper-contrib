<script lang="ts">
	/**
	 * A bounded list that says what it omits: rows inside the shared envelope (`Bounded`), which
	 * composes the omission sentence and renders a list that is not present through RegionState.
	 */
	import type { Snippet } from 'svelte';
	import Bounded from './Bounded.svelte';
	import type { RegionStateName } from './RegionState.svelte';

	let {
		children,
		...envelope
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
</script>

<Bounded {...envelope}>
	<div class="rows">
		{@render children?.()}
	</div>
</Bounded>

<style>
	.rows {
		min-width: 0;
	}
	.rows > :global(*) {
		display: flex;
		gap: 0.8rem;
		align-items: baseline;
		padding: 0.55rem 0;
		border-bottom: 1px solid var(--tp-rule);
		font-size: 0.85rem;
		color: var(--tp-text-muted);
		/* A flex row with default min-width keeps its nowrap children's full min-content width,
		   so a ResourceRef chip paints past the row's column. The row bounds to its container;
		   the chip's ellipsis engages. */
		min-width: 0;
	}
</style>
