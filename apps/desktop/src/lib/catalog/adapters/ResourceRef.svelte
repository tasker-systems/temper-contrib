<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import ResourceRef from '$lib/components/ResourceRef.svelte';

	let { props }: BaseComponentProps<{ id: string; titleHint?: string; block?: string }> = $props();
</script>

<div class="ref-row"><ResourceRef id={props.id} titleHint={props.titleHint} block={props.block} /></div>

<style>
	.ref-row {
		min-width: 0;
	}
</style>
