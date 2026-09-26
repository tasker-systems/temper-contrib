<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import RegionState, { type RegionStateName } from '$lib/components/RegionState.svelte';

	let { props }: BaseComponentProps<{ state: RegionStateName; label: string; detail?: string }> = $props();
</script>

<RegionState state={props.state} label={props.label} detail={props.detail} />
