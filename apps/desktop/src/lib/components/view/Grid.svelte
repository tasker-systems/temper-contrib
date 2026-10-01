<script lang="ts">
	/**
	 * Children in equal columns. A narrow container steps the count down rather than squeezing:
	 * the columns are a ceiling, read through a container query, never a style attribute.
	 */
	import type { Snippet } from 'svelte';
	import type { Gap } from './Stack.svelte';

	let {
		columns,
		gap = 'normal',
		children
	}: { columns: 1 | 2 | 3 | 4; gap?: Gap; children?: Snippet } = $props();
</script>

<div class="frame">
	<div class="grid cols-{columns} gap-{gap}">
		{@render children?.()}
	</div>
</div>

<style>
	.frame {
		container-type: inline-size;
		min-width: 0;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
	}
	.cols-1 {
		--cols: 1;
	}
	.cols-2 {
		--cols: 2;
	}
	.cols-3 {
		--cols: 3;
	}
	.cols-4 {
		--cols: 4;
	}
	@container (max-width: 40rem) {
		.cols-3,
		.cols-4 {
			--cols: 2;
		}
	}
	@container (max-width: 22rem) {
		.grid {
			--cols: 1;
		}
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
</style>
