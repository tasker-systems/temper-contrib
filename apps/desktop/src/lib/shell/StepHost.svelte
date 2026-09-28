<script lang="ts">
	/**
	 * One step of one tab: the subject, read once if it is a resource, seen through the lens that
	 * resolution chose. A resource's first read (`doc_open`) happens here, not in the room, because
	 * which lens shows a resource can depend on its doc type — so there is still exactly one read
	 * on opening, and the lens is handed the answer. The host resolves once per step; the lens only
	 * changes when the person switches it.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { untrack } from 'svelte';
	import RegionState from '$lib/components/RegionState.svelte';
	import type { DocOpened } from '$lib/document';
	import { enabled } from './contributions';
	import { type LensDecl, lensesFor, resolveLens } from './lenses';
	import { type Step, stepTitle, tabs } from './tabs.svelte';
	import UnbuiltLens from './UnbuiltLens.svelte';

	let { tabId, step }: { tabId: string; step: Step } = $props();

	// One host per step: the tab re-keys the host when the step changes.
	const subject = untrack(() => step.subject);
	const stepKey = untrack(() => step.key);
	const handle = tabs.handle(untrack(() => tabId), stepKey);

	let opened = $state<DocOpened | undefined>(undefined);
	if (subject.kind === 'resource') {
		invoke<DocOpened>('doc_open', { id: subject.id }).then(
			(answer) => {
				opened = answer;
			},
			(err) => {
				opened = { state: 'failed', id: subject.id, message: String(err) };
			}
		);
	}

	const arriving = $derived(subject.kind === 'resource' && opened === undefined);
	const docType = $derived(opened?.state === 'opened' ? opened.docType : null);
	const resolution = $derived(
		arriving ? null : resolveLens(subject, docType, step.lens, enabled)
	);

	const ref = $derived(opened?.state === 'opened' ? opened.decoratedRef : null);

	$effect(() => {
		if (!resolution) return;
		if (
			step.lens !== resolution.lens.id ||
			(docType && step.docType !== docType) ||
			(ref && step.ref !== ref)
		) {
			tabs.resolved(stepKey, resolution.lens.id, docType, ref);
		}
	});

	const lens = $derived(resolution?.lens ?? null);
	const loading = $derived(lens?.build.state === 'built' ? lens.build.component() : null);
	const alternatives = $derived(
		lensesFor(subject, docType, enabled).filter((l: LensDecl) => l.build.state === 'built')
	);
</script>

{#if arriving}
	<div class="page"><RegionState state="arriving" label="the document" /></div>
{:else if !lens}
	<div class="page">
		<RegionState state="empty" label="a lens for this" detail="No enabled lens shows this subject." />
	</div>
{:else if lens.build.state === 'unbuilt'}
	<UnbuiltLens
		lens={lens as LensDecl & { build: { state: 'unbuilt' } }}
		holds={stepTitle(step)}
		{alternatives}
		onchoose={(id) => tabs.setLens(tabId, id)}
	/>
{:else if loading}
	{#await loading}
		<div class="page"><RegionState state="arriving" label={`the ${lens.name} lens`} /></div>
	{:then mod}
		<mod.default {subject} {opened} tab={handle} />
	{:catch err}
		<div class="page">
			<RegionState state="failed" label={`the ${lens.name} lens`} detail={String(err)} />
		</div>
	{/await}
{/if}

<style>
	.page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
</style>
