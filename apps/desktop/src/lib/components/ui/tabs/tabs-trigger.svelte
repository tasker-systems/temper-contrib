<script lang="ts">
	import { Tabs } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let { value, children }: { value: string; children?: Snippet } = $props();
</script>

<Tabs.Trigger {value} class="tp-tabs-trigger">
	{@render children?.()}
</Tabs.Trigger>

<style>
	:global(.tp-tabs-trigger) {
		margin-bottom: -1px;
		padding: 0.45rem 0;
		border: none;
		border-bottom: 2px solid transparent;
		background: none;
		color: var(--tp-text-subtle);
		font: 0.65rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-label);
		text-transform: uppercase;
		cursor: pointer;
		transition: color var(--tp-motion-quick) var(--tp-motion-easing);
	}
	:global(.tp-tabs-trigger:hover) {
		color: var(--tp-text-muted);
	}
	:global(.tp-tabs-trigger[data-state='active']) {
		color: var(--tp-text);
		border-bottom-color: var(--tp-accent);
	}
</style>
