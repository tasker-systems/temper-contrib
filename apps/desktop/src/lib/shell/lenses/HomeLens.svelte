<script lang="ts">
	/**
	 * Core's home, interim: the temper views, and where the conversation went. It makes no claim
	 * about what awaits you or where to resume — those are the home build's, and until it lands
	 * this says only what it holds.
	 */
	import { agentSession } from '$lib/agent/session.svelte';
	import TemperViews from '$lib/components/TemperViews.svelte';
	import type { LensProps } from '../lenses';

	// A place lens takes the props every lens is handed and needs none of them.
	let _props: LensProps = $props();
</script>

<div class="page">
	<p class="t-label">home</p>
	<p class="t-strip">
		The conversation lives in the agent panel — it keeps running while you move between tabs,
		and a closed panel still shows its pending count on the
		<span class="strip-em">agent</span> toggle.
	</p>
	{#if !agentSession.panelOpen}
		<button class="t-action start" onclick={() => agentSession.setPanelOpen(true)}>
			start a session <span aria-hidden="true">→</span>
		</button>
	{/if}

	<TemperViews />
</div>

<style>
	.page {
		display: grid;
		gap: 0.8rem;
		max-width: 44rem;
		margin: 0 auto;
		padding: 2.5rem 1.5rem 4rem;
	}
	.t-label,
	.t-strip {
		margin: 0;
	}
	.strip-em {
		color: var(--tp-text);
	}
	.start {
		justify-self: start;
		padding: 0;
	}
</style>
