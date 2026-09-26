<script lang="ts" module>
	export type RegionStateName = 'arriving' | 'empty' | 'gave-up' | 'failed';
</script>

<script lang="ts">
	/**
	 * The region vocabulary: the one place arriving, empty, gave-up and failed get their
	 * appearance and their words. Carried from temper's web UI, re-pointed at theme roles.
	 *
	 * The states differ by four channels, deliberately — words, marker glyph, colour, border
	 * style — so removing any one still leaves them resolvable. `label` is composed into every
	 * sentence, so a consumer cannot word the arrival, refusal and failure out of step.
	 *
	 * - A pending region carries text, never a bare shimmer.
	 * - A failed region names what failed and says nothing was read — what separates it from empty.
	 * - A give-up names what the system stopped waiting for, never "timeout".
	 *
	 * ARIA: arriving and gave-up are `status` (neither is a fault); failed is `alert`.
	 */
	let { state, label, detail }: { state: RegionStateName; label: string; detail?: string | null } = $props();

	const named = $derived(label.charAt(0).toUpperCase() + label.slice(1));
</script>

{#if state === 'arriving'}
	<p class="region arriving" role="status">
		<span class="marker" aria-hidden="true">◌</span>
		<span>Loading {label}…{#if detail}<span class="detail">{detail}</span>{/if}</span>
	</p>
{:else if state === 'empty'}
	<p class="region empty">
		<span class="marker" aria-hidden="true">—</span>
		<span>No {label}.{#if detail}<span class="detail">{detail}</span>{/if}</span>
	</p>
{:else if state === 'gave-up'}
	<p class="region gave-up" role="status">
		<span class="marker" aria-hidden="true">⊘</span>
		<span>We stopped waiting for {label}.{#if detail}<span class="detail">{detail}</span>{/if}</span>
	</p>
{:else}
	<p class="region failed" role="alert">
		<span class="marker" aria-hidden="true">!</span>
		<span>{named} unavailable — nothing was read.{#if detail}<span class="detail">{detail}</span>{/if}</span>
	</p>
{/if}

<style>
	/* Scoped, not utilities: these appearances must not be overridable from a call site. */
	.region {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin: 0;
		padding: 7px 9px;
		border-left: 2px solid;
		border-radius: 0 5px 5px 0;
		font-family: var(--tp-font-ui);
		font-size: 12.5px;
		line-height: 1.5;
	}
	.marker {
		flex: none;
		font: 11px/1.4 var(--tp-font-doing);
	}
	.detail {
		margin-left: 0.35em;
		font-weight: 400;
		opacity: 0.85;
	}
	.arriving {
		border-left-style: dashed;
		border-left-color: var(--tp-region-arriving);
		background: var(--tp-region-arriving-wash);
		color: var(--tp-region-arriving);
	}
	.arriving .marker {
		animation: pulse 1.1s ease-in-out infinite;
	}
	.empty {
		border-left-color: var(--tp-rule-strong);
		background: var(--tp-region-empty-wash);
		color: var(--tp-region-empty);
		font-style: italic;
	}
	.gave-up {
		border-left-style: dotted;
		border-left-color: var(--tp-region-gave-up);
		background: var(--tp-region-gave-up-wash);
		color: var(--tp-region-gave-up);
	}
	.failed {
		border-left-color: var(--tp-region-failed);
		background: var(--tp-region-failed-wash);
		color: var(--tp-region-failed);
		font-weight: 600;
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 0.35;
		}
		50% {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.arriving .marker {
			animation: none;
		}
	}
</style>
