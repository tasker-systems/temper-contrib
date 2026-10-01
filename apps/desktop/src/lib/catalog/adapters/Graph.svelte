<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Graph from '$lib/components/view/Graph.svelte';

	let { props }: BaseComponentProps<ComponentProps<typeof Graph>> = $props();
</script>

<Graph {...props} />
