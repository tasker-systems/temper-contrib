<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Chart from '$lib/components/view/Chart.svelte';

	let { props }: BaseComponentProps<ComponentProps<typeof Chart>> = $props();
</script>

<Chart {...props} />
