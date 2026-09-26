<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import BoundedList from '$lib/components/BoundedList.svelte';

	type Props = {
		total: number;
		shown: number;
		scope: string;
		label: string;
		state: 'present' | 'arriving' | 'empty' | 'gave-up' | 'failed';
		more?: { step: number };
	};
	let { props, children, on }: BaseComponentProps<Props> = $props();

	// "Show more" appears only when the spec binds `more` to something: an offer that does
	// nothing when pressed would overstate itself.
	const more = $derived(on('more'));
</script>

<BoundedList {...props} more={more.bound ? props.more : undefined} onmore={() => more.emit()}>
	{#if children}
		{@render children()}
	{/if}
</BoundedList>
