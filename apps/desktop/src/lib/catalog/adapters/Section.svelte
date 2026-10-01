<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Section from '$lib/components/view/Section.svelte';

	let { props, children }: BaseComponentProps<Omit<ComponentProps<typeof Section>, 'children'>> = $props();
</script>

<Section {...props}>
	{#if children}
		{@render children()}
	{/if}
</Section>
