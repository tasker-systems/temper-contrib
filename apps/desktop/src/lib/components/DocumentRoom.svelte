<script lang="ts">
	/**
	 * The document room, read-only: body first. The properties strip sits above the rendered body
	 * and nothing sits beside it; what the document is connected to, and how it came to be, is
	 * in the about panel, read on request.
	 *
	 * The room does not read its own body: the tab that hosts it reads the body and its hash once,
	 * on opening, to learn which lens to show it through, and hands the answer here. Every other
	 * read is the panel's, and each renders its own state, so a failed read elsewhere never blanks
	 * the body. Once the answer names the document, the room names its tab.
	 */
	import { mergeProperties } from '$lib/properties';
	import type { DocOpened } from '$lib/document';
	import type { TabHandle } from '$lib/shell/lenses';
	import { ageWords } from '$lib/temper-views.svelte';
	import AboutPanel from './AboutPanel.svelte';
	import DocumentEditor from './DocumentEditor.svelte';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import PropertySet from './PropertySet.svelte';
	import RegionState from './RegionState.svelte';

	let {
		id,
		opened,
		tab
	}: {
		/** The reference the tab opened, whatever the read answered. */
		id: string;
		/** The host's open answer; absent while it is arriving. */
		opened?: DocOpened;
		tab?: TabHandle;
	} = $props();

	$effect(() => {
		if (opened?.state === 'opened') tab?.setTitle(opened.title);
	});

	const doc = $derived(opened?.state === 'opened' ? opened : null);
	const rows = $derived(doc ? mergeProperties(doc.managedMeta, doc.openMeta, doc.docType) : []);

	/** Spike (slice 3): the editor is mounted from the room's Edit affordance and nothing more. */
	let editing = $state(false);
	let draft = $state('');
	const dirty = $derived(doc !== null && draft !== doc.markdown);
</script>

<div class="page">
	{#if doc}
		<div class="ed-strip">
			<span>{doc.docType}</span>
			{#if doc.contextRef}<span class="ed-strip-sep">·</span><span>{doc.contextRef}</span>{/if}
			<span class="ed-strip-sep">·</span>
			<span>@{doc.ownerHandle}</span>
			<span class="ed-strip-sep">·</span>
			<time datetime={doc.updated} title={doc.updated}>updated {ageWords(Date.parse(doc.updated))}</time>
		</div>
		<div class="title-row">
			<h1 class="t-h2">{doc.title}</h1>
			{#if !editing}
				<button class="edit" type="button" onclick={() => {
					draft = doc.markdown;
					editing = true;
				}}>Edit</button>
			{/if}
		</div>
		{#if editing}
			<DocumentEditor bind:value={draft} initial={doc.markdown} />
			<div class="ed-strip draft-strip">
				<span>{dirty ? 'draft — not saved' : 'no changes yet'}</span>
			</div>
		{:else}
			<PropertySet {rows} />
		{/if}
	{:else if opened?.state === 'unresolved'}
		<RegionState
			state="empty"
			label="document at this reference"
			detail={`temper has nothing it would show here — ${opened.reason}`}
		/>
	{:else if opened?.state === 'failed'}
		<RegionState state="failed" label="this document" detail={opened.message} />
	{:else}
		<RegionState state="arriving" label="the document" />
	{/if}

	{#if opened?.state !== 'unresolved'}
		<AboutPanel {id} />
	{/if}

	{#if doc}
		<article class="body">
			<MarkdownRenderer markdown={doc.markdown} />
		</article>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: 1.2rem;
		max-width: 44rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
	h1 {
		margin: 0.6rem 0 0;
	}
	.title-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}
	.edit {
		flex: none;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		color: var(--tp-text);
		padding: 0.15rem 0.7rem;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.edit:hover {
		background: var(--tp-accent-wash);
		border-color: var(--tp-accent-line);
	}
	.draft-strip {
		color: var(--tp-text-subtle);
	}
	.body {
		padding-top: 0.6rem;
	}
</style>
