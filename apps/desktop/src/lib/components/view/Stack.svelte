<script lang="ts" module>
	export type Gap = 'tight' | 'normal' | 'loose';
</script>

<script lang="ts">
	/**
	 * Children in one direction. Every choice is a named step mapped to a class, never a length:
	 * the CSP refuses a style attribute, and a view should not choose its own spacing scale.
	 */
	import type { Snippet } from 'svelte';

	let {
		direction = 'vertical',
		gap = 'normal',
		align = 'stretch',
		wrap = false,
		children
	}: {
		direction?: 'vertical' | 'horizontal';
		gap?: Gap;
		align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
		wrap?: boolean;
		children?: Snippet;
	} = $props();
</script>

<div class="stack {direction} gap-{gap} align-{align}" class:wrap>
	{@render children?.()}
</div>

<style>
	.stack {
		display: flex;
		min-width: 0;
	}
	.vertical {
		flex-direction: column;
	}
	.horizontal {
		flex-direction: row;
	}
	.wrap {
		flex-wrap: wrap;
	}
	.gap-tight {
		gap: 0.4rem;
	}
	.gap-normal {
		gap: 0.9rem;
	}
	.gap-loose {
		gap: 1.6rem;
	}
	.align-start {
		align-items: flex-start;
	}
	.align-center {
		align-items: center;
	}
	.align-end {
		align-items: flex-end;
	}
	.align-stretch {
		align-items: stretch;
	}
	.align-baseline {
		align-items: baseline;
	}
	.stack > :global(*) {
		min-width: 0;
	}
</style>
