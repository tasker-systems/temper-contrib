<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Stat from '$lib/components/view/Stat.svelte';

	let { props }: BaseComponentProps<ComponentProps<typeof Stat>> = $props();
</script>

<Stat {...props} />
