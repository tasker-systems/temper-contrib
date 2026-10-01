<script lang="ts">
	import { Tabs } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let { label, children }: { label: string; children?: Snippet } = $props();
</script>

<Tabs.List class="tp-tabs-list" aria-label={label}>
	{@render children?.()}
</Tabs.List>

<style>
	:global(.tp-tabs-list) {
		display: flex;
		flex-wrap: wrap;
		gap: 1.2rem;
		border-bottom: 1px solid var(--tp-rule);
		margin-bottom: 0.9rem;
	}
</style>
