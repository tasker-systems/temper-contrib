<script lang="ts">
	/**
	 * The document room, read-only: body first. The properties strip sits above the rendered body
	 * and nothing sits beside it; what the document is connected to, and how it came to be, is
	 * in the about panel, read on request.
	 *
	 * The room reads the body and its hash once, on entry. Every other read is the panel's, and
	 * each renders its own state, so a failed read elsewhere never blanks the body.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { onDestroy, untrack } from 'svelte';
	import { type DocOpened, roomHref } from '$lib/document';
	import { mergeProperties } from '$lib/properties';
	import { roomTitles } from '$lib/room-title.svelte';
	import { ageWords } from '$lib/temper-views.svelte';
	import AboutPanel from './AboutPanel.svelte';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import PropertySet from './PropertySet.svelte';
	import RegionState from './RegionState.svelte';

	let { ident, walk }: { ident: string; walk: string[] } = $props();

	let opened = $state<DocOpened | null>(null);
	let failure = $state('');

	// One room per address: the route re-creates the room when the address changes, so the
	// reference is read once. The frame's title is keyed by that address, not by the walk.
	const asked = untrack(() => ident);
	const path = roomHref(asked);

	invoke<DocOpened>('doc_open', { id: asked }).then(
		(answer) => {
			opened = answer;
			if (answer.state === 'opened') roomTitles.set(path, answer.title);
		},
		(err) => {
			failure = String(err);
		}
	);

	onDestroy(() => roomTitles.clear(path));

	const doc = $derived(opened?.state === 'opened' ? opened : null);
	const rows = $derived(doc ? mergeProperties(doc.managedMeta, doc.openMeta, doc.docType) : []);
</script>

<main class="page">
	{#if doc}
		<div class="ed-strip">
			<span>{doc.docType}</span>
			{#if doc.contextRef}<span class="ed-strip-sep">·</span><span>{doc.contextRef}</span>{/if}
			<span class="ed-strip-sep">·</span>
			<span>@{doc.ownerHandle}</span>
			<span class="ed-strip-sep">·</span>
			<time datetime={doc.updated} title={doc.updated}>updated {ageWords(Date.parse(doc.updated))}</time>
		</div>
		<h1 class="t-h2">{doc.title}</h1>
		<PropertySet {rows} />
	{:else if opened?.state === 'unresolved'}
		<RegionState
			state="empty"
			label="document at this reference"
			detail={`temper has nothing it would show here — ${opened.reason}`}
		/>
	{:else if opened?.state === 'failed'}
		<RegionState state="failed" label="this document" detail={opened.message} />
	{:else if failure}
		<RegionState state="failed" label="this document" detail={failure} />
	{:else}
		<RegionState state="arriving" label="the document" />
	{/if}

	{#if opened?.state !== 'unresolved'}
		<AboutPanel id={ident} {walk} />
	{/if}

	{#if doc}
		<article class="body">
			<MarkdownRenderer markdown={doc.markdown} />
		</article>
	{/if}
</main>

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
	.body {
		padding-top: 0.6rem;
	}
</style>
