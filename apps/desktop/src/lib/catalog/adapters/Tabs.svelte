<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Tabs from '$lib/components/view/Tabs.svelte';

	let { props, children }: BaseComponentProps<Omit<ComponentProps<typeof Tabs>, 'children'>> = $props();
</script>

<Tabs {...props}>
	{#if children}
		{@render children()}
	{/if}
</Tabs>
