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
	import { agentSession } from '$lib/agent/session.svelte';
	import AgentPanel from '$lib/components/AgentPanel.svelte';
	import TemperProfile from '$lib/components/TemperProfile.svelte';
	import { follow } from './follow';
	import Masthead from './Masthead.svelte';
	import RoomStrip from './RoomStrip.svelte';
	import TabHost from './TabHost.svelte';
	import TabStrip from './TabStrip.svelte';
	import { stepTitle, tabs } from './tabs.svelte';

	// Idempotent: the store's listeners register once, whatever mounts.
	agentSession.init();

	let root: HTMLDivElement | undefined = $state();

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

	$effect(() => {
		const id = agentSession.conversation?.conversationId;
		if (!id) return;
		invoke('acp_ask_surface', { conversationId: id, present: true }).catch(() => {});
		return () => {
			invoke('acp_ask_surface', { conversationId: id, present: false }).catch(() => {});
		};
	});
</script>

{#snippet profileSlot()}
	<TemperProfile />
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
	<Masthead agentToggle={agentToggle} profile={profileSlot} />
	<div class="body">
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
