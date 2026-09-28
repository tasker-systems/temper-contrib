<script lang="ts">
	/**
	 * The document room: body first. The properties strip sits above the rendered body and nothing
	 * sits beside it; what the document is connected to, and how it came to be, is in the about
	 * panel, read on request.
	 *
	 * The room does not read its own body: the tab that hosts it reads the body and its hash once,
	 * on opening, to learn which lens to show it through, and hands the answer here. Every other
	 * read is the panel's, and each renders its own state, so a failed read elsewhere never blanks
	 * the body. Once the answer names the document, the room names its tab.
	 *
	 * Editing (slice 3): Edit opens the editor over the composed markdown. The draft saves
	 * through `doc_save_body`, guarded by the hash the room recorded at open — a save against a
	 * moved base never lands, and its refusal orients the person (SaveRefusal) instead of
	 * overwriting or merging. A byte-identical save is prevented client-side: the Save button is
	 * disabled while the text equals the base, so no ledger churn is invited. While a draft is
	 * dirty the room holds the tab — beforeLeave answers with the draft's sentence — and the
	 * save's outcome replaces the base in place: the room re-renders from the saved answer, and
	 * any open panel tab refreshes against the same resource on its next read.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { mergeProperties } from '$lib/properties';
	import type { BodySaved, DocOpened } from '$lib/document';
	import type { TabHandle } from '$lib/shell/lenses';
	import { ageWords } from '$lib/temper-views.svelte';
	import AboutPanel from './AboutPanel.svelte';
	import DocumentEditor from './DocumentEditor.svelte';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import PropertySet from './PropertySet.svelte';
	import RegionState from './RegionState.svelte';
	import SaveRefusal from './SaveRefusal.svelte';

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

	let editing = $state(false);
	let draft = $state('');
	let saving = $state(false);
	let saveFailed = $state('');
	let refusal = $state<Extract<BodySaved, { state: 'refused' }> | null>(null);

	/** The base the draft is measured against: the opened hash until a keep-on-newer re-bases it. */
	let baseHash = $state('');
	let baseMarkdown = $state('');
	/** What the editor seeds its document with: captured at startEdit, and at a keep-on-newer
	 * re-base (the draft, re-seeded on the newer base). Read once by the editor's mount effect —
	 * never a live expression, or every keystroke would re-create the editor. */
	let seed = $state('');
	const dirty = $derived(doc !== null && editing && draft !== doc.markdown);

	// The draft guard: while a draft is dirty the tab is asked before it leaves its step.
	$effect(() => {
		if (!tab || !dirty) return;
		const release = tab.beforeLeave(() =>
			'This document has an unsaved draft — leave anyway? The draft is kept until you close the tab.'
		);
		return release;
	});

	function startEdit(): void {
		if (!doc) return;
		baseHash = doc.bodyHash;
		baseMarkdown = doc.markdown;
		draft = doc.markdown;
		seed = doc.markdown;
		refusal = null;
		saveFailed = '';
		editing = true;
	}

	function stopEditing(): void {
		editing = false;
		refusal = null;
		saveFailed = '';
	}

	async function save(): Promise<void> {
		if (!doc || saving || !dirty) return;
		saving = true;
		saveFailed = '';
		try {
			const answer = await invoke<BodySaved>('doc_save_body', {
				id,
				baseHash,
				baseMarkdown,
				content: draft
			});
			saving = false;
			if (answer.state === 'saved') {
				// The room's base moves to what was written: the next save compares against it.
				baseHash = answer.bodyHash ?? baseHash;
				stopEditing();
				// The body the room renders is the room's own answer's; the host re-reads nothing —
				// show the saved text by re-opening through the room's own read path.
				await refresh();
			} else if (answer.state === 'refused') {
				refusal = answer;
			} else if (answer.state === 'unresolved') {
				saveFailed = `temper has nothing it would save here — ${answer.reason}`;
			} else {
				saveFailed = answer.message;
			}
		} catch (err) {
			saving = false;
			saveFailed = String(err);
		}
	}

	/** Re-read the document the room is about, through the same command the host used. */
	async function refresh(): Promise<void> {
		try {
			const fresh = await invoke<DocOpened>('doc_open', { id });
			// The host owns `opened`; the room shows the fresh answer by swapping its own view of
			// the document. The host's copy updates on its next open, which a tab switch re-keys.
			if (fresh.state === 'opened') {
				// The host handed us its state; the room renders from a local copy it can replace.
				localOpened = fresh;
			}
		} catch (err) {
			saveFailed = String(err);
		}
	}

	/** The room's view of the document: the host's answer until the room re-reads after a save. */
	let localOpened = $state<DocOpened | null>(null);
	const shown = $derived(localOpened ?? opened);

	function takeNewer(): void {
		if (refusal && refusal.current.state === 'opened') {
			localOpened = refusal.current;
		}
		stopEditing();
	}

	function keepDraft(): void {
		if (refusal && refusal.current.state === 'opened') {
			// The person has seen the newer version; the draft is now measured against it.
			baseHash = refusal.current.bodyHash;
			baseMarkdown = refusal.current.markdown;
			localOpened = refusal.current;
			seed = draft;
			refusal = null;
			// Stay in editing: the draft stands on the newer base.
		} else {
			stopEditing();
		}
	}
</script>

<div class="page">
	{#if shown?.state === 'opened'}
		{@const d = shown}
		<div class="ed-strip">
			<span>{d.docType}</span>
			{#if d.contextRef}<span class="ed-strip-sep">·</span><span>{d.contextRef}</span>{/if}
			<span class="ed-strip-sep">·</span>
			<span>@{d.ownerHandle}</span>
			<span class="ed-strip-sep">·</span>
			<time datetime={d.updated} title={d.updated}>updated {ageWords(Date.parse(d.updated))}</time>
		</div>
		<div class="title-row">
			<h1 class="t-h2">{d.title}</h1>
			<div class="edit-actions">
				{#if editing}
					<button class="edit" type="button" onclick={stopEditing} disabled={saving}>
						Done
					</button>
					<button
						class="edit save"
						type="button"
						onclick={save}
						disabled={saving || !dirty}
					>
						{saving ? 'Saving…' : 'Save'}
					</button>
				{:else}
					<button class="edit" type="button" onclick={startEdit}>Edit</button>
				{/if}
			</div>
		</div>
		{#if refusal}
			<!-- The refusal takes the editor's place while it stands: the person reads it, then
			     chooses. The draft is kept either way until Take newer or a landed save closes it. -->
			<SaveRefusal refused={refusal} ontakeNewer={takeNewer} onkeepDraft={keepDraft} />
		{:else if editing}
			<!-- The seed is the draft when one stands (a refusal unmounted the editor; keeping
			     the draft remounts it with the person's text), else the document as opened. -->
			<DocumentEditor bind:value={draft} initial={seed} />
			<div class="ed-strip draft-strip">
				<span>{saving ? 'saving…' : dirty ? 'draft — not saved' : 'no changes yet'}</span>
				{#if saveFailed}<span class="failed">{saveFailed}</span>{/if}
			</div>
		{:else}
			<PropertySet rows={mergeProperties(d.managedMeta, d.openMeta, d.docType)} />
		{/if}
	{:else if shown?.state === 'unresolved'}
		<RegionState
			state="empty"
			label="document at this reference"
			detail={`temper has nothing it would show here — ${shown.reason}`}
		/>
	{:else if shown?.state === 'failed'}
		<RegionState state="failed" label="this document" detail={shown.message} />
	{:else}
		<RegionState state="arriving" label="the document" />
	{/if}

	{#if shown?.state !== 'unresolved'}
		<AboutPanel {id} />
	{/if}

	{#if shown?.state === 'opened'}
		<article class="body">
			<MarkdownRenderer markdown={shown.markdown} />
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
	.edit:hover:not(:disabled) {
		background: var(--tp-accent-wash);
		border-color: var(--tp-accent-line);
	}
	.edit:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.save {
		border-color: var(--tp-accent-line);
	}
	.draft-strip {
		color: var(--tp-text-subtle);
	}
	.draft-strip .failed {
		color: var(--tp-danger);
	}
	.body {
		padding-top: 0.6rem;
	}
</style>