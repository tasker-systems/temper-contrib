<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Heading from '$lib/components/view/Heading.svelte';

	let { props }: BaseComponentProps<ComponentProps<typeof Heading>> = $props();
</script>

<Heading {...props} />
