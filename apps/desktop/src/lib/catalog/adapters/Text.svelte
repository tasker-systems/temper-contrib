<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Text from '$lib/components/view/Text.svelte';

	let { props }: BaseComponentProps<ComponentProps<typeof Text>> = $props();
</script>

<Text {...props} />
