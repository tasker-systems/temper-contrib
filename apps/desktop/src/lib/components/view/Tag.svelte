<script lang="ts" module>
	/** A tint is a categorical role or a condition — never a colour. */
	export type Category = `cat-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
	export type Tint = Category | 'notice' | 'success' | 'danger' | 'pending';
</script>

<script lang="ts">
	/**
	 * A short label, tinted by a categorical role or a condition. The one place a tint becomes an
	 * appearance: Table's category cells and Timeline's markers draw through it too. `dot` draws
	 * only the marker, for a row whose words are elsewhere.
	 */
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
		--tag-ink: var(--tp-text-muted);
		--tag-line: var(--tp-rule-strong);
		--tag-wash: transparent;
	}
	.dot[data-tint='none'] {
		background: transparent;
	}
	[data-tint='cat-1'] { --tag-ink: var(--tp-cat-1); --tag-line: var(--tp-cat-1); }
	[data-tint='cat-2'] { --tag-ink: var(--tp-cat-2); --tag-line: var(--tp-cat-2); }
	[data-tint='cat-3'] { --tag-ink: var(--tp-cat-3); --tag-line: var(--tp-cat-3); }
	[data-tint='cat-4'] { --tag-ink: var(--tp-cat-4); --tag-line: var(--tp-cat-4); }
	[data-tint='cat-5'] { --tag-ink: var(--tp-cat-5); --tag-line: var(--tp-cat-5); }
	[data-tint='cat-6'] { --tag-ink: var(--tp-cat-6); --tag-line: var(--tp-cat-6); }
	[data-tint='cat-7'] { --tag-ink: var(--tp-cat-7); --tag-line: var(--tp-cat-7); }
	[data-tint='cat-8'] { --tag-ink: var(--tp-cat-8); --tag-line: var(--tp-cat-8); }
	[data-tint='notice'] { --tag-ink: var(--tp-notice); --tag-line: var(--tp-notice); --tag-wash: var(--tp-notice-wash); }
	[data-tint='success'] { --tag-ink: var(--tp-success); --tag-line: var(--tp-success); --tag-wash: var(--tp-success-wash); }
	[data-tint='danger'] { --tag-ink: var(--tp-danger); --tag-line: var(--tp-danger); --tag-wash: var(--tp-danger-wash); }
	[data-tint='pending'] { --tag-ink: var(--tp-pending); --tag-line: var(--tp-pending); --tag-wash: var(--tp-pending-wash); }
</style>
