<script lang="ts">
	// Fonts are bundled, never fetched: the desktop must render offline.
	import '@fontsource-variable/source-serif-4';
	import '@fontsource-variable/source-serif-4/wght-italic.css';
	import '@fontsource-variable/jetbrains-mono';
	import '@fontsource-variable/inter';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { themeStore } from '$lib/theme-store.svelte';
	import RoomFrame from '$lib/components/RoomFrame.svelte';
	import TemperProfile from '$lib/components/TemperProfile.svelte';
	import { temperViews } from '$lib/temper-views.svelte';
	import { roomTitles } from '$lib/room-title.svelte';

	let { children } = $props();

	themeStore.init();
	temperViews.init();

	$effect(() => {
		document.documentElement.dataset.theme = themeStore.active;
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

<RoomFrame {rooms} {room} profile={profileSlot} />

{@render children()}
