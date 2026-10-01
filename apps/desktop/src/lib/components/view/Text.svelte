<script lang="ts">
	/**
	 * A paragraph of plain text, on base.css's type recipes. Never markup: whatever the text holds
	 * is shown as written.
	 */
	let { text, tone = 'body' }: { text: string; tone?: 'body' | 'muted' | 'subtle' | 'label' } =
		$props();
</script>

<p class={tone === 'label' ? 't-label' : `t-body ${tone}`}>{text}</p>

<style>
	p {
		margin: 0;
		overflow-wrap: anywhere;
		white-space: pre-line;
	}
	.body {
		color: var(--tp-text);
	}
	.muted {
		color: var(--tp-text-muted);
	}
	.subtle {
		color: var(--tp-text-subtle);
		font-size: 0.9rem;
	}
</style>
