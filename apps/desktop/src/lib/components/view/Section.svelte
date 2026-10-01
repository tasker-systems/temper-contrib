<script lang="ts">
	/**
	 * A titled part of a view. Held by Tabs it is one tab's panel; held by Accordion, one
	 * collapsible item; on its own, a titled block. What it holds never inherits its holder, so
	 * a Section inside a tab's panel is a titled block again.
	 */
	import { type Snippet, untrack } from 'svelte';
	import * as Accordion from '../ui/accordion';
	import * as Tabs from '../ui/tabs';
	import { releaseSections, sectionHolder } from './sections';

	let { title, open = false, children }: { title: string; open?: boolean; children?: Snippet } =
		$props();

	const holder = sectionHolder();
	// Read once: a Section's place in its holder, and its title there, are fixed when it joins.
	const value = untrack(() => holder?.join(title, open)) ?? '';
	releaseSections();
</script>

{#if holder?.kind === 'tabs'}
	<Tabs.Content {value}>{@render children?.()}</Tabs.Content>
{:else if holder?.kind === 'accordion'}
	<Accordion.Item {value} {title}>{@render children?.()}</Accordion.Item>
{:else}
	<section>
		<h4 class="t-label">{title}</h4>
		{@render children?.()}
	</section>
{/if}

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-width: 0;
	}
	h4 {
		margin: 0;
		color: var(--tp-text-subtle);
	}
</style>
