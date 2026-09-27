<script lang="ts">
	/**
	 * A document's properties, read-only. Ported from temper-ui's PropertySet.svelte
	 * (tasker-systems/temper, packages/temper-ui/src/lib/components/vault/PropertySet.svelte, at
	 * ee12cd5) by copy-with-citation: the read half, re-pointed at theme roles. The state and
	 * description controls arrive with metadata editing.
	 *
	 * Managed keys lead, tinted toward the accent; a rule separates them from the open keys.
	 */
	import type { PropertyRow } from '$lib/properties';
	import PropertyValue from './PropertyValue.svelte';

	let { rows }: { rows: PropertyRow[] } = $props();

	// Managed keys always lead (mergeProperties guarantees the order), so the rule sits before
	// the first open row.
	let firstOpenKey = $derived(rows.find((r) => !r.managed)?.key ?? null);
</script>

<div class="props">
	<p class="t-strip">Properties · {rows.length}</p>
	<dl>
		{#each rows as row (row.key)}
			{#if row.key === firstOpenKey}
				<hr />
			{/if}
			<div class="row" class:managed={row.managed}>
				<dt>{row.key}</dt>
				<dd><PropertyValue value={row.value} /></dd>
			</div>
		{/each}
	</dl>
</div>

<style>
	.props {
		padding: 0.8rem 1rem 0.9rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
	}
	.t-strip {
		margin: 0 0 0.5rem;
	}
	dl {
		margin: 0;
	}
	.row {
		display: grid;
		grid-template-columns: 9rem 1fr;
		gap: 0.6rem;
		padding: 0.15rem 0;
		align-items: start;
	}
	dt {
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
		overflow-wrap: anywhere;
	}
	dd {
		margin: 0;
		min-width: 0;
	}
	.managed dt {
		color: var(--tp-accent);
	}
	hr {
		margin: 0.45rem 0;
		border: 0;
		border-top: 1px dashed var(--tp-rule-strong);
	}
</style>
