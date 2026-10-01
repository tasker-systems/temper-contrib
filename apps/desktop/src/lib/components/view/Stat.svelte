<script lang="ts">
	/**
	 * One figure with its label. A change carries its direction in words and glyph, and its tone
	 * separately: up is not always good, so the direction never chooses the colour.
	 */
	let {
		label,
		value,
		unit,
		delta,
		detail
	}: {
		label: string;
		value: string | number;
		unit?: string;
		delta?: { value: string; direction: 'up' | 'down' | 'flat'; tone?: 'success' | 'danger' | 'neutral' };
		detail?: string;
	} = $props();

	const glyph = { up: '▲', down: '▼', flat: '▬' } as const;
	const shown = $derived(typeof value === 'number' ? value.toLocaleString() : value);
</script>

<div class="stat">
	<p class="t-label label">{label}</p>
	<p class="figure">
		<span class="value">{shown}</span>{#if unit}<span class="unit">{unit}</span>{/if}
	</p>
	{#if delta}
		<p class="delta {delta.tone ?? 'neutral'}">
			<span aria-hidden="true">{glyph[delta.direction]}</span>
			<span class="sr">{delta.direction}</span>
			{delta.value}
		</p>
	{/if}
	{#if detail}<p class="detail">{detail}</p>{/if}
</div>

<style>
	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.8rem 1rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-panel);
		background: var(--tp-surface);
		min-width: 0;
	}
	p {
		margin: 0;
	}
	.label {
		color: var(--tp-text-subtle);
	}
	.figure {
		display: flex;
		align-items: baseline;
		gap: 0.3rem;
		color: var(--tp-text);
		overflow-wrap: anywhere;
	}
	.value {
		font: 300 1.9rem/1.15 var(--tp-font-reading);
	}
	.unit {
		font: 0.8rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	.delta {
		font: 0.75rem var(--tp-font-doing);
	}
	.neutral {
		color: var(--tp-text-muted);
	}
	.success {
		color: var(--tp-success);
	}
	.danger {
		color: var(--tp-danger);
	}
	.detail {
		font: italic 0.8rem/1.4 var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
