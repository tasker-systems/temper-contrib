<script lang="ts" module>
	export type ChatMessage = {
		role: 'user' | 'assistant' | 'system';
		text: string;
		/** What went with a person's prompt: the name of the room shared with the agent. */
		with?: string;
		toolCallId?: string;
		status?: string;
	};
</script>

<script lang="ts">
	/**
	 * The conversation transcript. Agents stream markdown, so assistant messages render through
	 * `MarkdownRenderer` (the sanitized baseline); what the person typed renders as the literal
	 * text they typed; tool-call entries are one line each, refreshed in place by the page.
	 */
	import MarkdownRenderer from './MarkdownRenderer.svelte';

	let {
		messages,
		pending = null
	}: {
		messages: ChatMessage[];
		/** Who is responding, while a prompt is in flight; null otherwise. */
		pending?: string | null;
	} = $props();
</script>

<div class="transcript">
	{#each messages as message, i (i)}
		{#if message.role === 'assistant'}
			<div class="assistant"><MarkdownRenderer markdown={message.text} /></div>
		{:else}
			<p class={message.role}>
				{message.text}{message.status ? ` · ${message.status}` : ''}
				{#if message.with}<span class="with">with: <em>{message.with}</em></span>{/if}
			</p>
		{/if}
	{/each}
	{#if pending}
		<p class="pending" role="status"><span aria-hidden="true">◌</span> {pending} is responding…</p>
	{/if}
</div>

<style>
	.with {
		display: block;
		margin-top: 0.2rem;
		font: 0.6rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-strip);
		color: var(--tp-text-subtle);
	}
	.with em {
		font: italic 0.8rem var(--tp-font-reading);
		letter-spacing: normal;
		color: var(--tp-text-muted);
	}
	.transcript {
		box-sizing: border-box;
		width: 100%;
		max-height: 360px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.9rem 1rem;
		background: var(--tp-surface);
		border: 1px solid var(--tp-rule);
	}
	p {
		margin: 0;
		white-space: pre-wrap;
	}
	.user {
		font: 500 0.9rem/1.6 var(--tp-font-ui);
		color: var(--tp-text);
	}
	.system {
		font: 0.68rem var(--tp-font-doing);
		letter-spacing: 0.04em;
		color: var(--tp-text-subtle);
	}
	.pending {
		font: italic 0.85rem var(--tp-font-reading);
		color: var(--tp-region-arriving);
	}
</style>
