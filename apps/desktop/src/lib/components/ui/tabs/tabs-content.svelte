<script lang="ts">
	import { Tabs } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let { value, children }: { value: string; children?: Snippet } = $props();
</script>

<Tabs.Content {value} class="tp-tabs-content">
	{@render children?.()}
</Tabs.Content>

<style>
	:global(.tp-tabs-content) {
		min-width: 0;
	}
</style>
