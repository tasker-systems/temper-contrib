<script lang="ts">
	/**
	 * The envelope every bounded view shares: it says what it omits. The omission sentence is
	 * composed from `total`, `shown`, `scope` and, for a page, `page` (`omission.ts`), so no author
	 * words it out of step with the numbers. When the view is not present, or present with nothing to stand for, its state
	 * renders through RegionState and its content does not.
	 */
	import type { Snippet } from 'svelte';
	import { omissionSentence, type Page } from './omission';
	import RegionState, { type RegionStateName } from './RegionState.svelte';

	let {
		total,
		shown,
		scope,
		label,
		state,
		page,
		more,
		onmore,
		children
	}: {
		total: number;
		shown: number;
		scope: string;
		label: string;
		state: 'present' | RegionStateName;
		/** When the view is one page of its total: which rows, and whether more follow. */
		page?: Page | null;
		more?: { step: number } | null;
		onmore?: () => void;
		children?: Snippet;
	} = $props();

	const omitted = $derived(Math.max(0, total - shown));
	const sentence = $derived(omissionSentence(total, shown, scope, page));
</script>

{#if state === 'present' && total === 0}
	<RegionState state="empty" {label} />
{:else if state === 'present'}
	<div class="bounded">
		{@render children?.()}
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
	.bounded {
		/* A grid item (inside the section that hosts this view) with default min-width: auto
		   floors at its content's min-content width and overflows its track. Clamp it. */
		min-width: 0;
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
