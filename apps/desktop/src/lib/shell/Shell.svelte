<script lang="ts">
	/**
	 * The shell: one window, many rooms. The masthead holds what belongs to the window; the tab
	 * strip and room strip hold what belongs to a tab and its step; the agent panel holds what
	 * belongs to the session. Every open tab is a live room: inactive ones are hidden, never
	 * unmounted, so a background tab keeps its reads, its scroll and its state. A tab restored at
	 * startup is not mounted until it is first shown.
	 *
	 * The engagement outlives every tab: the session store owns the listeners, and the shell is
	 * the conversation's ask surface while a conversation lives. Neither a closed panel nor a tab
	 * switch releases it — the agent toggle carries the pending count, so there is always
	 * somewhere an ask is being put to the person.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { agentSession } from '$lib/agent/session.svelte';
	import AgentPanel from '$lib/components/AgentPanel.svelte';
	import TemperProfile from '$lib/components/TemperProfile.svelte';
	import CommandPalette from './CommandPalette.svelte';
	import { follow } from './follow';
	import Masthead from './Masthead.svelte';
	import { shellPanels } from './panels.svelte';
	import RoomStrip from './RoomStrip.svelte';
	import TabHost from './TabHost.svelte';
	import TabStrip from './TabStrip.svelte';
	import { stepTitle, tabs } from './tabs.svelte';
	import WaysIn from './WaysIn.svelte';

	// Idempotent: the store's listeners register once, whatever mounts.
	agentSession.init();

	let root: HTMLDivElement | undefined = $state();

	/** The palette's shortcut as this platform writes it. */
	const paletteKeys =
		typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
			? '⌘K'
			: 'Ctrl K';

	$effect(() => {
		if (!root) return;
		const onFollow = (event: MouseEvent) => follow(event, tabs);
		root.addEventListener('click', onFollow);
		root.addEventListener('auxclick', onFollow);
		return () => {
			root?.removeEventListener('click', onFollow);
			root?.removeEventListener('auxclick', onFollow);
		};
	});

	// ⌘K / Ctrl-K opens the palette from anywhere in the window; it toggles closed again.
	$effect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				shellPanels.setPaletteOpen(!shellPanels.paletteOpen);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	$effect(() => {
		const id = agentSession.conversation?.conversationId;
		if (!id) return;
		invoke('acp_ask_surface', { conversationId: id, present: true }).catch(() => {});
		return () => {
			invoke('acp_ask_surface', { conversationId: id, present: false }).catch(() => {});
		};
	});

	// The window-close draft guard: the core prevented a close over a dirty draft and says so.
	// The person confirms here; the confirm clears the flag and closes, past the guard. The
	// webview's own confirm() is the ask — no capability widened, no new channel minted.
	let unlistenClose: UnlistenFn | null = null;
	listen('doc-close-requested', () => {
		const confirmed = window.confirm(
			'This document has an unsaved draft — close anyway? The draft is kept until you close the tab.'
		);
		if (confirmed) invoke('doc_close_confirmed').catch(() => {});
	}).then((u) => {
		unlistenClose = u;
	});
</script>

{#snippet profileSlot()}
	<TemperProfile />
{/snippet}

{#snippet waysToggle()}
	<button
		class="t-action ways-toggle"
		aria-pressed={shellPanels.waysOpen}
		aria-label={shellPanels.waysOpen ? 'Close the ways-in panel' : 'Open the ways-in panel'}
		onclick={() => shellPanels.setWaysOpen(!shellPanels.waysOpen)}>ways in</button
	>
{/snippet}

{#snippet paletteTrigger()}
	<button
		class="palette-trigger"
		aria-haspopup="dialog"
		aria-expanded={shellPanels.paletteOpen}
		onclick={() => shellPanels.setPaletteOpen(true)}
	>
		<span>Open, switch lens, or run a command…</span>
		<span class="keys" aria-hidden="true">{paletteKeys}</span>
	</button>
{/snippet}

{#snippet agentToggle()}
	<button
		class="t-action agent-toggle"
		aria-pressed={agentSession.panelOpen}
		aria-label={agentSession.panelOpen
			? 'Close the agent panel'
			: agentSession.asks.length
				? `Open the agent panel — ${agentSession.asks.length} awaiting your answer`
				: 'Open the agent panel'}
		onclick={() => agentSession.setPanelOpen(!agentSession.panelOpen)}
	>
		<span aria-hidden="true">◆</span> agent{#if !agentSession.panelOpen && agentSession.asks.length}
			<span class="agent-pending" aria-hidden="true"> ◇ {agentSession.asks.length}</span>{/if}
	</button>
{/snippet}

<div class="shell" bind:this={root}>
	<Masthead {waysToggle} palette={paletteTrigger} {agentToggle} profile={profileSlot} />
	<div class="body">
		{#if shellPanels.waysShown}
			<div class="ways" hidden={!shellPanels.waysOpen}>
				<WaysIn />
			</div>
		{/if}
		<main class="rooms">
			<TabStrip />
			<RoomStrip />
			<div class="bodies">
				{#each tabs.tabs as tab (tab.id)}
					{#if tabs.mounted[tab.id]}
						<section
							class="tab-body"
							hidden={tab.id !== tabs.activeId}
							aria-label={stepTitle(tabs.current(tab))}
							data-tab={tab.id}
						>
							<TabHost {tab} />
						</section>
					{/if}
				{/each}
			</div>
		</main>
		<div class="agent" hidden={!agentSession.panelOpen}>
			<AgentPanel />
		</div>
	</div>
	{#if shellPanels.paletteOpen}
		<CommandPalette />
	{/if}
</div>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}
	.body {
		display: flex;
		flex: 1;
		min-height: 0;
	}
	.rooms {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.bodies {
		flex: 1;
		min-height: 0;
		position: relative;
	}
	.tab-body {
		position: absolute;
		inset: 0;
		overflow-y: auto;
	}
	.tab-body[hidden] {
		display: none;
	}
	.ways-toggle {
		white-space: nowrap;
	}
	.ways {
		display: flex;
		flex: none;
		min-height: 0;
	}
	.ways[hidden] {
		display: none;
	}
	.palette-trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		width: min(26rem, 32vw);
		height: 1.9rem;
		box-sizing: border-box;
		margin-left: 1rem;
		padding: 0 0.75rem;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		font: 0.8rem var(--tp-font-ui);
		color: var(--tp-text-subtle);
		cursor: pointer;
	}
	.palette-trigger:hover {
		border-color: var(--tp-accent-line-soft);
	}
	.palette-trigger span:first-child {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.keys {
		flex: none;
		font: 0.68rem var(--tp-font-doing);
	}
	.agent {
		display: flex;
		flex: none;
		min-height: 0;
	}
	.agent[hidden] {
		display: none;
	}
	.agent-pending {
		color: var(--tp-pending);
	}
</style>
