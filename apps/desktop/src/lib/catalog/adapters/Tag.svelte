<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Tag from '$lib/components/view/Tag.svelte';

	let { props }: BaseComponentProps<ComponentProps<typeof Tag>> = $props();
</script>

<Tag {...props} />
