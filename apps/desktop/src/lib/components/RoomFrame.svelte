<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The frame every room shares: the room's declared identity, the way out, and the
	 * masthead's bounded navigation (the room-frame plan). It is the masthead reduced to
	 * the invariants that never leave — the chrome recedes; it does not participate in
	 * the room's content, and no json-render catalog component can draw it.
	 */

	type RoomLink = { href: string; label: string };

	/** The room's declared identity, carried by the route's load. The root declares no way out — an exit that cannot complete is a false affordance. */
	type Room = { title?: string; wayOut?: RoomLink };

	interface Props {
		/** The rooms that exist — the building's map, bounded and honest about what it holds. */
		rooms: RoomLink[];
		room?: Room;
		/** Slots other builds own. An unfilled slot renders nothing — never a placeholder claiming a state. */
		reach?: Snippet;
		pending?: Snippet;
		cacheAge?: Snippet;
	}

	let { rooms, room, reach, pending, cacheAge }: Props = $props();
</script>

<header class="masthead">
	{#if room?.wayOut}
		<a class="t-way-out" href={room.wayOut.href}>
			<span class="t-way-out-arrow" aria-hidden="true">←</span>
			{room.wayOut.label}
		</a>
	{/if}
	<svg viewBox="0 0 32 32" aria-hidden="true">
		<path d="M 12 7 L 12 25" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none" />
		<path d="M 6 13 L 18 13 Q 23 13 25 16.5 Q 27 20 25 24" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" fill="none" />
	</svg>
	<a class="t-wordmark" href="/">temper</a>
	{#if room?.title}
		<span class="t-room-title">{room.title}</span>
	{/if}
	<nav class="t-strip">
		{#each rooms as link, i (link.href)}
			{#if i > 0}<span class="t-sep" aria-hidden="true">·</span>{/if}
			<a href={link.href}>{link.label}</a>
		{/each}
	</nav>
	<span class="spacer"></span>
	{#if reach}
		<span class="t-slot-reach">{@render reach()}</span>
	{/if}
	{#if pending}
		<span class="t-slot-pending">{@render pending()}</span>
	{/if}
	{#if cacheAge}
		<span class="t-slot-cacheAge">{@render cacheAge()}</span>
	{/if}
</header>

<style>
	.masthead {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		padding: 0.9rem 1.5rem;
		border-bottom: 1px solid var(--tp-rule);
		color: var(--tp-accent);
	}
	.masthead svg {
		width: 20px;
		height: 20px;
	}
	.masthead a {
		text-decoration: none;
	}
	.t-way-out {
		color: var(--tp-text);
	}
	.t-way-out-arrow {
		font-family: var(--tp-font-doing), monospace;
	}
	.t-room-title {
		color: var(--tp-text);
	}
	nav {
		display: flex;
		gap: 0.5rem;
	}
	nav a {
		color: inherit;
	}
	nav a:hover {
		color: var(--tp-text);
	}
	.spacer {
		flex: 1;
	}
</style>
