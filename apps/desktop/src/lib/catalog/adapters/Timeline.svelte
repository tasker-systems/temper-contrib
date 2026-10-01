<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Timeline from '$lib/components/view/Timeline.svelte';

	let { props }: BaseComponentProps<ComponentProps<typeof Timeline>> = $props();
</script>

<Timeline {...props} />
