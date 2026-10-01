<script lang="ts" module>
	/** A tint is a categorical role or a condition — never a colour. */
	export type Category = `cat-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
	export type Tint = Category | 'notice' | 'success' | 'danger' | 'pending';
</script>

<script lang="ts">
	/**
	 * A short label, tinted by a categorical role or a condition. Table's category cells and
	 * Timeline's markers draw through it; which role a tint names is `tints.css`, shared with Graph.
	 * `dot` draws only the marker, for a row whose words are elsewhere.
	 */
	import './tints.css';

	let { label, tint, dot = false }: { label: string; tint?: Tint | null; dot?: boolean } = $props();
</script>

{#if dot}
	<span class="dot" data-tint={tint ?? 'none'} aria-hidden="true"></span>
{:else}
	<span class="tag" data-tint={tint ?? 'none'}>{label}</span>
{/if}

<style>
	.tag {
		display: inline-block;
		max-width: 100%;
		padding: 0.05rem 0.45rem;
		border: 1px solid var(--tag-line);
		border-radius: var(--tp-radius-chip);
		background: var(--tag-wash);
		color: var(--tag-ink);
		font: 0.7rem/1.5 var(--tp-font-doing);
		letter-spacing: 0.02em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		vertical-align: baseline;
	}
	.dot {
		display: inline-block;
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		border: 1px solid var(--tag-line);
		background: var(--tag-ink);
	}
	[data-tint] {
		--tag-ink: var(--tint, var(--tp-text-muted));
		--tag-line: var(--tint, var(--tp-rule-strong));
		--tag-wash: transparent;
	}
	.dot[data-tint='none'] {
		background: transparent;
	}
	[data-tint='notice'] { --tag-wash: var(--tp-notice-wash); }
	[data-tint='success'] { --tag-wash: var(--tp-success-wash); }
	[data-tint='danger'] { --tag-wash: var(--tp-danger-wash); }
	[data-tint='pending'] { --tag-wash: var(--tp-pending-wash); }
</style>
