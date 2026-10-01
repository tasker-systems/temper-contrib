<script lang="ts">
	/** Sections shown one at a time, chosen by their titles; the first is shown first. */
	import type { Snippet } from 'svelte';
	import * as Ui from '../ui/tabs';
	import { holdSections } from './sections';

	let { label, children }: { label: string; children?: Snippet } = $props();

	let sections = $state<{ value: string; title: string }[]>([]);
	let active = $state('section-0');
	holdSections({
		kind: 'tabs',
		join(title) {
			const value = `section-${sections.length}`;
			sections.push({ value, title });
			return value;
		}
	});
</script>

<div class="tabs">
	<Ui.Root bind:value={active}>
		<Ui.List {label}>
			{#each sections as section (section.value)}
				<Ui.Trigger value={section.value}>{section.title}</Ui.Trigger>
			{/each}
		</Ui.List>
		{@render children?.()}
	</Ui.Root>
</div>

<style>
	.tabs {
		min-width: 0;
	}
</style>
