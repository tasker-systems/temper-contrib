<script lang="ts">
	import { Accordion } from 'bits-ui';
	import type { Snippet } from 'svelte';

	let { value, title, children }: { value: string; title: string; children?: Snippet } = $props();
</script>

<Accordion.Item {value} class="tp-accordion-item">
	<Accordion.Header level={3} class="tp-accordion-header">
		<Accordion.Trigger class="tp-accordion-trigger">
			<span class="title">{title}</span>
			<span class="chevron" aria-hidden="true">›</span>
		</Accordion.Trigger>
	</Accordion.Header>
	<Accordion.Content class="tp-accordion-content">
		{@render children?.()}
	</Accordion.Content>
</Accordion.Item>

<style>
	:global(.tp-accordion-item) {
		border-bottom: 1px solid var(--tp-rule);
	}
	:global(.tp-accordion-header) {
		margin: 0;
	}
	:global(.tp-accordion-trigger) {
		display: flex;
		width: 100%;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0.6rem 0;
		border: none;
		background: none;
		color: var(--tp-text);
		font: 400 0.95rem/1.4 var(--tp-font-reading);
		text-align: left;
		cursor: pointer;
	}
	:global(.tp-accordion-trigger:hover) {
		color: var(--tp-accent);
	}
	.title {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.chevron {
		color: var(--tp-text-subtle);
		transition: transform var(--tp-motion-quick) var(--tp-motion-easing);
	}
	:global(.tp-accordion-trigger[data-state='open']) .chevron {
		transform: rotate(90deg);
	}
	:global(.tp-accordion-content) {
		padding: 0 0 0.9rem;
		min-width: 0;
	}
</style>
