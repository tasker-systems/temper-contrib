<script lang="ts">
	/**
	 * "About this document": closed by default, closable, and saying it is there when closed.
	 * Four tabs, each its own read, made only when the tab is first opened — opening the room
	 * reads the body and nothing else. Each tab keeps its own state, so a failed read renders
	 * in that tab alone and never reaches the body or another tab. A tab read once stays read
	 * while the room is open; closing the panel withholds it, it does not discard it. A failed
	 * read is not kept as an answer: the tab offers to read again.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import {
		type Connections,
		type History,
		PANEL_TABS,
		type PanelRead,
		type PanelTab,
		type Related,
		type Sources
	} from '$lib/document';
	import ConnectionList from './ConnectionList.svelte';
	import HistoryList from './HistoryList.svelte';
	import RegionState from './RegionState.svelte';
	import RelatedList from './RelatedList.svelte';
	import SourceList from './SourceList.svelte';

	let { id }: { id: string } = $props();

	type TabState = { state: 'arriving' } | PanelRead<unknown>;

	let open = $state(false);
	let active = $state<PanelTab>('connections');
	const reads = $state<Partial<Record<PanelTab, TabState>>>({});

	function select(tab: PanelTab): void {
		active = tab;
		if (reads[tab]) return;
		const command = PANEL_TABS.find((t) => t.key === tab)?.command;
		if (!command) return;
		reads[tab] = { state: 'arriving' };
		invoke<PanelRead<unknown>>(command, { id }).then(
			(answer) => {
				reads[tab] = answer;
			},
			(err) => {
				reads[tab] = { state: 'failed', message: String(err) };
			}
		);
	}

	function readAgain(tab: PanelTab): void {
		delete reads[tab];
		select(tab);
	}

	function toggle(): void {
		open = !open;
		if (open) select(active);
	}

	const label = (tab: PanelTab) =>
		tab === 'related' ? 'related resources' : tab === 'sources' ? 'recorded sources' : tab;
	const current = $derived(reads[active]);
</script>

<section class="about" aria-label="About this document">
	<button class="t-action toggle" aria-expanded={open} onclick={toggle}>
		<span aria-hidden="true">{open ? '⌄' : '›'}</span>
		{open ? 'Close about this document' : 'About this document'}
	</button>
	{#if !open}
		<p class="withheld">Connections, related resources, history and sources — read when you open them.</p>
	{:else}
		<div class="tabs" role="tablist">
			{#each PANEL_TABS as tab (tab.key)}
				<button
					class="t-action"
					role="tab"
					aria-selected={active === tab.key}
					onclick={() => select(tab.key)}
				>
					{tab.label}
				</button>
			{/each}
		</div>
		<div class="panel" role="tabpanel" aria-label={PANEL_TABS.find((t) => t.key === active)?.label}>
			{#if !current || current.state === 'arriving'}
				<RegionState state="arriving" label={label(active)} />
			{:else if current.state === 'failed'}
				<RegionState state="failed" label={label(active)} detail={current.message} />
				<button class="t-action again" onclick={() => readAgain(active)}>Read again</button>
			{:else if current.state === 'unresolved'}
				<RegionState
					state="failed"
					label={label(active)}
					detail={`temper found nothing it would show at this reference — ${current.reason}`}
				/>
			{:else if active === 'connections'}
				<ConnectionList connections={current.data as Connections} />
			{:else if active === 'related'}
				<RelatedList related={current.data as Related} />
			{:else if active === 'history'}
				<HistoryList history={current.data as History} />
			{:else}
				<SourceList sources={current.data as Sources} />
			{/if}
		</div>
	{/if}
</section>

<style>
	.about {
		display: grid;
		gap: 0.6rem;
		padding: 0.7rem 1rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-chip);
	}
	.toggle {
		justify-self: start;
		padding: 0;
	}
	.panel {
		display: grid;
		gap: 0.5rem;
	}
	.again {
		justify-self: start;
		padding: 0;
	}
	.withheld {
		margin: 0;
		font: italic 0.82rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
	.tabs {
		display: flex;
		gap: 1.2rem;
		padding-bottom: 0.4rem;
		border-bottom: 1px solid var(--tp-rule);
	}
	.tabs button {
		padding: 0;
		color: var(--tp-text-subtle);
	}
	.tabs button[aria-selected='true'] {
		color: var(--tp-text);
	}
</style>
