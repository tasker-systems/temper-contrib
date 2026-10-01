<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Grid from '$lib/components/view/Grid.svelte';

	let { props, children }: BaseComponentProps<Omit<ComponentProps<typeof Grid>, 'children'>> = $props();
</script>

<Grid {...props}>
	{#if children}
		{@render children()}
	{/if}
</Grid>
