<script lang="ts">
	/**
	 * Home's "Presented views": the presented views recorded in the person's own contexts, newest
	 * first — the records' own way back. It reads nothing of this device: no session, no agent,
	 * no tab strip — discarding the tab state loses no presented view, because the record, not
	 * the tab, is what a row opens. A row hands the record's subject to the tabs model, whose
	 * presentation lens rebuilds the view from the record; the view is never rendered inside the
	 * section.
	 *
	 * The read is bounded twice and both bounds are named: the list it reads carries a bounded
	 * number of records (the remainder is counted in the answer), and the section shows a few of
	 * those — the omission sentence says which. Records the read could not admit are counted and
	 * named, never dropped silently.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import BoundedList from '$lib/components/BoundedList.svelte';
	import RegionState from '$lib/components/RegionState.svelte';
	import { ageWords } from '$lib/temper-views.svelte';
	import type { LensProps } from '../../lenses';
	import { tabs } from '../../tabs.svelte';

	let { shown = 0 }: LensProps = $props();

	/** How many rows are shown. */
	const ROWS = 5;

	type PresentedRecord = {
		version: number;
		conversationId: string;
		agent: string;
		catalogVersion: string;
		presentedAt: string;
		/** The spec, verbatim as the record carries it; the projection's check
		    guarantees the root element named here is present. */
		spec: { root: string; elements: Record<string, { type: string }> };
		outcome: string;
	};

	type PresentedView = { resource: string; artifact: string; record: PresentedRecord };

	type PresentedList =
		| { state: 'arriving' }
		| { state: 'present'; views: PresentedView[]; total: number; refused: number }
		| { state: 'failed'; message: string };

	let list = $state<PresentedList>({ state: 'arriving' });
	let readShow = -1;

	$effect(() => {
		const show = shown;
		if (show === readShow) return;
		readShow = show;
		void read(show);
	});

	async function read(show: number): Promise<void> {
		try {
			const answer = await invoke<{ views: PresentedView[]; total: number; refused: number }>(
				'present_list'
			);
			if (show === readShow) {
				list = {
					state: 'present',
					views: answer.views,
					total: answer.total,
					refused: answer.refused
				};
			}
		} catch (e) {
			if (show === readShow && list.state !== 'present') {
				list = { state: 'failed', message: String(e) };
			}
		}
	}

	/**
	 * One gesture returns: the tab already showing this record is focused, else a new one opens
	 * through the presentation lens — the record's own rebuild path.
	 */
	function reopen(view: PresentedView): void {
		tabs.focusOrOpen(
			{ kind: 'presentation', resource: view.resource, artifact: view.artifact },
			'core/presentation'
		);
	}

	const rows = $derived(list.state === 'present' ? list.views.slice(0, ROWS) : []);
	/** Views the list's own bound left on the hubs, as the answer counts them. */
	const remainder = $derived(
		list.state === 'present' ? Math.max(0, list.total - list.views.length) : 0
	);

	const scope = $derived(list.state === 'present' ? 'your records, newest first' : '');

	/** The row's chip: the root component's type, as the record's own spec names it — the
	    word "view" when a degraded record carries none. Home never crashes on one. */
	function viewType(view: PresentedView): string {
		const at = view.record.spec.elements[view.record.spec.root];
		return at ? at.type : 'view';
	}
</script>

{#if list.state === 'arriving'}
	<RegionState state="arriving" label="the views presented to you" />
{:else if list.state === 'failed'}
	<RegionState state="failed" label="the views presented to you" detail={list.message} />
{:else}
	<div class="presented">
		<p class="t-strip heading">{scope}</p>
		<BoundedList
			label="presented views recorded yet"
			scope="presented views"
			state="present"
			total={list.total}
			shown={rows.length}
		>
			{#each rows as view (view.artifact)}
				<button class="entry" onclick={() => reopen(view)}>
					<span class="type">{viewType(view)}</span>
					<span class="main">{view.record.agent}</span>
					<span class="sub">{ageWords(Date.parse(view.record.presentedAt))}</span>
				</button>
			{/each}
		</BoundedList>
		{#if list.refused > 0}
			<p class="honest">
				{list.refused}
				{list.refused === 1 ? 'record' : 'records'} on the hubs could not be read as a presented
				view.
			</p>
		{/if}
		{#if remainder > 0}
			<p class="honest">
				The list carries the {list.views.length} newest; {remainder}
				{remainder === 1 ? 'older one stays' : 'older ones stay'} on the hubs’ records.
			</p>
		{/if}
	</div>
{/if}

<style>
	.presented {
		display: grid;
		gap: 0.3rem;
		/* Track clamp: the section's rows bound to it, never hold it at a nowrap chip's width. */
		min-width: 0;
	}
	.heading,
	.honest {
		margin: 0;
	}
	.honest {
		font: italic 0.8rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
	.type {
		flex: none;
		font: 0.56rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-label);
		text-transform: uppercase;
		color: var(--tp-text-subtle);
	}
	.entry {
		/* The row chrome comes from BoundedList's shared row rule; a button's own chrome is
		   reset here, and the shared rule's border re-stated, so the row — not the widget —
		   shows whichever way the two stylesheets order. */
		width: 100%;
		padding: 0.55rem 0;
		border: none;
		border-bottom: 1px solid var(--tp-rule);
		background: none;
		text-align: left;
		cursor: pointer;
	}
	.main {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: italic 0.88rem var(--tp-font-reading);
		color: var(--tp-text);
	}
	.sub {
		flex: none;
		font-size: 0.78rem;
		color: var(--tp-text-subtle);
	}
</style>
