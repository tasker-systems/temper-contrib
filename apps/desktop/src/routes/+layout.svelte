<script lang="ts">
	// Fonts are bundled, never fetched: the desktop must render offline.
	import '@fontsource-variable/source-serif-4';
	import '@fontsource-variable/source-serif-4/wght-italic.css';
	import '@fontsource-variable/jetbrains-mono';
	import '@fontsource-variable/inter';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { invoke } from '@tauri-apps/api/core';
	import type { Snippet } from 'svelte';
	import { themeStore } from '$lib/theme-store.svelte';
	import RoomFrame from '$lib/components/RoomFrame.svelte';
	import AgentPanel from '$lib/components/AgentPanel.svelte';
	import TemperProfile from '$lib/components/TemperProfile.svelte';
	import { agentSession } from '$lib/agent/session.svelte';
	import { temperViews } from '$lib/temper-views.svelte';
	import { roomTitles } from '$lib/room-title.svelte';

	// Children is optional-safe: the layout is a component test's subject
	// too, where no route page is mounted under it.
	let { children } = $props<{ children?: Snippet }>();

	themeStore.init();
	temperViews.init();
	// The engagement outlives every route: the store owns the listeners, so
	// switching rooms never stops the conversation, drops streamed output, or
	// cancels a parked ask. Idempotent.
	agentSession.init();

	$effect(() => {
		document.documentElement.dataset.theme = themeStore.active;
	});

	// The shell (this layout) is the conversation's ask surface while a
	// conversation lives: the backend parks permission asks here and cancels
	// them the moment no one can answer. Neither a closed panel nor a room
	// change releases it — the panel's toggle carries the pending count, so
	// there is always somewhere an ask is being put to the person.
	$effect(() => {
		const id = agentSession.conversation?.conversationId;
		if (!id) return;
		invoke('acp_ask_surface', { conversationId: id, present: true }).catch(() => {});
		return () => {
			invoke('acp_ask_surface', { conversationId: id, present: false }).catch(() => {});
		};
	});

	// The rooms that exist — the building's map, bounded and honest about what it holds.
	const rooms = [
		{ href: '/', label: 'home' },
		{ href: '/settings', label: 'settings' }
	];

	// Rooms declare their identity through their load; the merged route data carries it to the
	// frame. A room that learns its title from a read names it once the read lands.
	const room = $derived.by(() => {
		const declared = page.data.room;
		const resolved = roomTitles.get(page.url.pathname);
		return declared && resolved ? { ...declared, title: resolved } : declared;
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#snippet profileSlot()}
	<TemperProfile />
{/snippet}

{#snippet agentToggle()}
	{#if !agentSession.panelOpen}
		<button
			class="t-action agent-toggle"
			aria-label={agentSession.asks.length
				? `Open the agent panel — ${agentSession.asks.length} awaiting your answer`
				: 'Open the agent panel'}
			onclick={() => agentSession.setPanelOpen(true)}
		>
			agent{#if agentSession.asks.length}
				<span class="agent-pending" aria-hidden="true"> ◇ {agentSession.asks.length}</span>{/if}
		</button>
	{/if}
{/snippet}

{#snippet reachSlot()}
	{#if agentSession.conversation}
		{#if agentSession.selection.modes}
			<span class="t-strip">
				mode ·
				{agentSession.selection.modes.availableModes.find(
					(m) => m.id === agentSession.selection.modes?.currentModeId
				)?.name ?? agentSession.selection.modes.currentModeId}
			</span>
		{:else}
			<span class="t-strip">reach · the agent's own — the desktop relays what it asks, and doesn't limit what it writes</span>
		{/if}
	{/if}
{/snippet}

{#snippet pendingSlot()}
	{#if agentSession.conversation && agentSession.prompting}
		<span class="t-strip">◇ {agentSession.agentLabel()} is responding…</span>
	{/if}
{/snippet}

<div class="body">
	<main class="route">{@render children?.()}</main>
	{#if agentSession.panelOpen}
		<AgentPanel />
	{/if}
</div>

<style>
	.body {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: start;
		min-height: calc(100vh - 3.5rem);
	}
	.route {
		min-width: 0;
	}
	.agent-pending {
		color: var(--tp-notice);
	}
</style>

<RoomFrame {rooms} {room} agentToggle={agentToggle} reach={reachSlot} pending={pendingSlot} profile={profileSlot} />