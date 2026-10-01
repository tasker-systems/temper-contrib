<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Table from '$lib/components/view/Table.svelte';

	let { props }: BaseComponentProps<ComponentProps<typeof Table>> = $props();
</script>

<Table {...props} />
