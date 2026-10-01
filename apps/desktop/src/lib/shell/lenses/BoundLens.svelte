<script lang="ts">
	/**
	 * Every bound lens: its spec filled by the core from one read (`lens_resolve`) and rendered
	 * through TemperView. The core fills the props as a function of the read's answer and checks
	 * the result; TemperView checks it again. Nothing between the read and the view composes it.
	 *
	 * Paging and sorting are view actions the bound component declares: each re-resolves the lens
	 * from a new read. The view in hand stays drawn while the next one arrives, marked busy — a
	 * page turn never blanks the table, and one that fails says so beside it, with a way to try
	 * again. A read that failed and a view the core refused are told apart: a refusal had a read.
	 * Where in the listing the reader is lives as long as the step; going back to it reads from the
	 * first page again.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import RegionState from '$lib/components/RegionState.svelte';
	import TemperView from '$lib/catalog/TemperView.svelte';
	import type { ViewActionHandlers } from '$lib/catalog/view-actions';
	import { getRefResolver, type Resolution } from '$lib/refs';
	import type { LensProps } from '../lenses';

	type Sort = { key: string; order: 'asc' | 'desc' };
	type View = { offset: number; sort?: Sort };

	let { subject, lens }: LensProps = $props();

	let view = $state<View>({ offset: 0 });
	let spec = $state<unknown>(null);
	/** The last resolve's failure: the read itself, or the view the core made from it. */
	let failure = $state<{ refused: boolean; message: string } | null>(null);
	/** Bumped by "try again", so the same view is asked for anew. */
	let attempt = $state(0);
	let busy = $state(false);
	// The read already said what each row is: its refs resolve from that answer, not a read apiece.
	const resolver = getRefResolver();

	const bound = $derived(lens?.build.state === 'bound' ? lens.build : null);

	$effect(() => {
		if (!bound || subject.kind !== 'query') return;
		const asked = { offset: view.offset, sort: view.sort };
		void attempt;
		let gone = false;
		busy = true;
		invoke<{ spec: unknown; refs: Resolution[] }>('lens_resolve', {
			spec: bound.spec,
			binding: bound.binding,
			subject: { context: subject.context, docType: subject.docType, text: subject.text },
			view: asked
		}).then(
			(answer) => {
				if (gone) return;
				resolver.prime(answer.refs);
				spec = answer.spec;
				failure = null;
				busy = false;
			},
			(err) => {
				if (gone) return;
				const message = String(err);
				failure = { refused: message.startsWith('the filled view was refused'), message };
				busy = false;
			}
		);
		return () => {
			gone = true;
		};
	});

	const actions: ViewActionHandlers = {
		'Table.page': (params) => {
			view = { ...view, offset: params.offset as number };
		},
		'Table.sort': (params) => {
			view = { offset: 0, sort: params as Sort };
		}
	};
</script>

<div class="page">
	{#if !bound}
		<RegionState state="failed" label="this lens" detail="it is not a bound lens" />
	{:else if subject.kind !== 'query'}
		<RegionState state="failed" label={`the ${lens?.name} lens`} detail="it shows a listing, and this is not one" />
	{:else if spec === null && failure && !failure.refused}
		<RegionState state="failed" label={`the ${lens?.name}`} detail={failure.message} />
	{:else if spec === null && !failure}
		<RegionState state="arriving" label={`the ${lens?.name}`} />
	{:else}
		{#if failure}
			<p class="failure" role="alert">
				{failure.refused
					? `The ${lens?.name} was read, but the view made from it was refused: ${failure.message}`
					: `The next view of the ${lens?.name} could not be read: ${failure.message}`}
				<button class="ed-action" onclick={() => (attempt += 1)}>Try again</button>
			</p>
		{/if}
		{#if spec !== null}
			<div class="view" aria-busy={busy}>
				<TemperView {spec} {actions} />
			</div>
		{/if}
	{/if}
</div>

<style>
	.page {
		max-width: 64rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
		min-width: 0;
	}
	.failure {
		margin: 0 0 1rem;
		padding: 0.6rem 0.9rem;
		border-left: 2px solid var(--tp-region-failed);
		background: var(--tp-region-failed-wash);
		color: var(--tp-region-failed);
		font-size: 0.82rem;
	}
	.failure button {
		margin-left: 0.4rem;
	}
	.view[aria-busy='true'] {
		opacity: 0.6;
	}
</style>
