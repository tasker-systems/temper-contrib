<script lang="ts" module>
	export type TimelineItem = {
		when: string;
		title: string;
		detail?: string;
		ref?: string;
		tint?: Tint;
	};
</script>

<script lang="ts">
	/**
	 * Dated items in the order given, inside the bounded envelope. A date is shown as written —
	 * the author chose its precision (a month, a day, a moment), and reformatting would claim one
	 * it did not give.
	 */
	import Bounded from '../Bounded.svelte';
	import type { RegionStateName } from '../RegionState.svelte';
	import ResourceRef from '../ResourceRef.svelte';
	import Tag, { type Tint } from './Tag.svelte';

	let {
		total,
		scope,
		label,
		state,
		items
	}: {
		total: number;
		scope: string;
		label: string;
		state: 'present' | RegionStateName;
		items: TimelineItem[];
	} = $props();
</script>

<Bounded {total} shown={items.length} {scope} {label} {state}>
	<ol class="timeline" aria-label={label}>
		{#each items as item, i (i)}
			<li>
				<span class="mark"><Tag label={item.title} tint={item.tint} dot /></span>
				<time class="when" datetime={item.when}>{item.when}</time>
				<div class="what">
					<p class="title">{item.title}</p>
					{#if item.detail}<p class="detail">{item.detail}</p>{/if}
					{#if item.ref}<div class="ref"><ResourceRef id={item.ref} /></div>{/if}
				</div>
			</li>
		{/each}
	</ol>
</Bounded>

<style>
	.timeline {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		position: relative;
		display: grid;
		grid-template-columns: 1rem 6.5rem minmax(0, 1fr);
		gap: 0.6rem;
		align-items: baseline;
		padding: 0.45rem 0;
	}
	/* The spine: a rule from each marker to the next. */
	li:not(:last-child)::before {
		content: '';
		position: absolute;
		left: calc(0.275rem - 0.5px);
		top: 1.2rem;
		bottom: -0.5rem;
		border-left: 1px solid var(--tp-rule);
	}
	.mark {
		line-height: 1;
	}
	.when {
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.what {
		min-width: 0;
	}
	p {
		margin: 0;
	}
	.title {
		color: var(--tp-text);
		font-size: 0.9rem;
		overflow-wrap: anywhere;
	}
	.detail {
		font: 0.82rem/1.5 var(--tp-font-reading);
		color: var(--tp-text-muted);
		overflow-wrap: anywhere;
	}
	.ref {
		margin-top: 0.2rem;
		min-width: 0;
	}
</style>
