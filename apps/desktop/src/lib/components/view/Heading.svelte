<script lang="ts">
	/** A heading, plain text. Level 1 titles a view; 2 and 3 divide it. */
	let { text, level }: { text: string; level: 1 | 2 | 3 } = $props();
</script>

{#if level === 1}
	<h2 class="h1">{text}</h2>
{:else if level === 2}
	<h3 class="h2">{text}</h3>
{:else}
	<h4 class="h3">{text}</h4>
{/if}

<style>
	/* A view sits under its tab's own title, so its level 1 is the page's second level. */
	h2,
	h3,
	h4 {
		margin: 0;
		color: var(--tp-text);
		overflow-wrap: anywhere;
	}
	.h1 {
		font: 300 1.6rem/1.3 var(--tp-font-reading);
	}
	.h2 {
		font: 400 1.15rem/1.4 var(--tp-font-reading);
	}
	.h3 {
		font: 500 0.7rem/1.5 var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-label);
		text-transform: uppercase;
		color: var(--tp-text-subtle);
	}
</style>
