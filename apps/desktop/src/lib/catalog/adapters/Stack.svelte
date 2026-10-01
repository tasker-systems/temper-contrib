<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Stack from '$lib/components/view/Stack.svelte';

	let { props, children }: BaseComponentProps<Omit<ComponentProps<typeof Stack>, 'children'>> = $props();
</script>

<Stack {...props}>
	{#if children}
		{@render children()}
	{/if}
</Stack>
