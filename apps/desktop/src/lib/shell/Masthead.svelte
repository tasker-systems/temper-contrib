<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChromeMenu from '$lib/components/ChromeMenu.svelte';

	/**
	 * The window's masthead: what belongs to the window, whatever tab is in view. The chrome
	 * recedes — it does not participate in a room's content, and no json-render catalog component
	 * can draw it. What belongs to a step (its title, its way out, its lens) is the room strip's;
	 * what belongs to the session (reach, pending asks) is the agent panel's.
	 */
	interface Props {
		/** The command palette's trigger. */
		palette?: Snippet;
		/** The agent panel's toggle, carrying the pending-ask count while the panel is closed. */
		agentToggle?: Snippet;
		/** Slots other builds own. An unfilled slot renders nothing — never a placeholder claiming a state. */
		profile?: Snippet;
	}

	let { palette, agentToggle, profile }: Props = $props();
</script>

<header class="masthead">
	<ChromeMenu />
	<svg viewBox="0 0 32 32" aria-hidden="true">
		<path d="M 12 7 L 12 25" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none" />
		<path d="M 6 13 L 18 13 Q 23 13 25 16.5 Q 27 20 25 24" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" fill="none" />
	</svg>
	<a class="t-wordmark" href="/" aria-label="temper — home">temper</a>
	{#if palette}
		<span class="t-slot-palette">{@render palette()}</span>
	{/if}
	<span class="spacer"></span>
	{#if profile}
		<span class="t-slot-profile">{@render profile()}</span>
	{/if}
	{#if agentToggle}
		<span class="t-slot-agentToggle">{@render agentToggle()}</span>
	{/if}
</header>

<style>
	.masthead {
		display: flex;
		align-items: center;
		gap: 1rem;
		height: 3rem;
		box-sizing: border-box;
		padding: 0 1.1rem;
		border-bottom: 1px solid var(--tp-rule);
		color: var(--tp-accent);
	}
	.masthead svg {
		width: 20px;
		height: 20px;
	}
	.t-wordmark {
		text-decoration: none;
	}
	.spacer {
		flex: 1;
	}
	/* The profile says what temper declares, and a long connection sentence stays one line: the
	   masthead holds its height, and the full sentence is the profile's own to show. */
	.t-slot-profile {
		min-width: 0;
		max-width: 34vw;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
