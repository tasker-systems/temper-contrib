<script lang="ts">
	/** Collapsible Sections; one open at a time unless `multiple`. Sections start open by `open`. */
	import type { Snippet } from 'svelte';
	import * as Ui from '../ui/accordion';
	import { holdSections } from './sections';

	let { multiple = false, children }: { multiple?: boolean; children?: Snippet } = $props();

	let opened = $state<string[]>([]);
	let count = 0;
	holdSections({
		kind: 'accordion',
		join(_title, open) {
			const value = `section-${count++}`;
			if (open && (multiple || opened.length === 0)) opened.push(value);
			return value;
		}
	});
	let single = $derived(opened[0] ?? '');
</script>

<div class="accordion">
	{#if multiple}
		<Ui.Root type="multiple" bind:value={opened}>{@render children?.()}</Ui.Root>
	{:else}
		<Ui.Root type="single" bind:value={() => single, (v) => (opened = v ? [v] : [])}>
			{@render children?.()}
		</Ui.Root>
	{/if}
</div>

<style>
	.accordion {
		border-top: 1px solid var(--tp-rule);
		min-width: 0;
	}
</style>
