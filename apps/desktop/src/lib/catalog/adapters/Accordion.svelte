<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Accordion from '$lib/components/view/Accordion.svelte';

	let { props, children }: BaseComponentProps<Omit<ComponentProps<typeof Accordion>, 'children'>> = $props();
</script>

<Accordion {...props}>
	{#if children}
		{@render children()}
	{/if}
</Accordion>
