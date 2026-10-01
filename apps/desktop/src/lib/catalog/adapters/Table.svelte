<script lang="ts">
	import type { BaseComponentProps } from '@json-render/svelte';
	import type { ComponentProps } from 'svelte';
	import Table, { type Sort } from '$lib/components/view/Table.svelte';
	import { getViewActions } from '../view-actions';

	type Props = Omit<ComponentProps<typeof Table>, 'onpage' | 'onsort'>;
	let { props }: BaseComponentProps<Props> = $props();

	// Paging and sorting are the host's: offered only when it handles them.
	const actions = getViewActions();
	const onpage = $derived(
		actions.handles('Table', 'page')
			? (offset: number) => actions.act('Table', 'page', { offset })
			: undefined
	);
	const onsort = $derived(
		actions.handles('Table', 'sort')
			? (sort: Sort) => actions.act('Table', 'sort', sort)
			: undefined
	);
</script>

<Table {...props} {onpage} {onsort} />
