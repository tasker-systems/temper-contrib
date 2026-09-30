<script lang="ts" module>
	export type ChatMessage = {
		role: 'user' | 'assistant' | 'system';
		text: string;
		/** What went with a person's prompt: the name of the room shared with the agent. */
		with?: string;
		toolCallId?: string;
		status?: string;
		/** Where a rendered presentation's record lives — the tab line's rebuildable subject. */
		tab?: { resource: string; artifact: string };
	};
</script>

<script lang="ts">
	/**
	 * The conversation transcript. Agents stream markdown, so assistant messages render through
	 * `MarkdownRenderer` (the sanitized baseline); what the person typed renders as the literal
	 * text they typed; tool-call entries are one line each, refreshed in place by the page. A
	 * rendered presentation's line carries its tab: the link opens the presented view through the
	 * one door, `onTab` — never a second path into the shell.
	 */
	import MarkdownRenderer from './MarkdownRenderer.svelte';

	let {
		messages,
		pending = null,
		onTab
	}: {
		messages: ChatMessage[];
		/** Who is responding, while a prompt is in flight; null otherwise. */
		pending?: string | null;
		/** Follow a rendered presentation's tab line into its recorded view. */
		onTab?: (tab: { resource: string; artifact: string }) => void;
	} = $props();
</script>

<div class="transcript">
	{#each messages as message, i (i)}
		{#if message.role === 'assistant'}
			<div class="assistant"><MarkdownRenderer markdown={message.text} /></div>
		{:else}
			<p class={message.role}>
				{#if message.tab}
					<button class="tab-link" onclick={() => onTab?.(message.tab!)}>{message.text}</button>
				{:else}
					{message.text}{message.status ? ` · ${message.status}` : ''}
					{#if message.with}<span class="with">with: <em>{message.with}</em></span>{/if}
				{/if}
			</p>
		{/if}
	{/each}
	{#if pending}
		<p class="pending" role="status"><span aria-hidden="true">◌</span> {pending} is responding…</p>
	{/if}
</div>

<style>
	.tab-link {
		font: inherit;
		letter-spacing: inherit;
		color: var(--tp-text-muted);
		background: none;
		border: none;
		padding: 0;
		text-align: left;
		cursor: pointer;
	}
	.tab-link:hover {
		color: var(--tp-text);
	}
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
