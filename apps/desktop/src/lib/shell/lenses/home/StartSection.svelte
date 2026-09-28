<script lang="ts">
	/**
	 * Home's "Start": begin a session with an agent (ruling B). Starting is the person's gesture, so
	 * opening the agent panel here is asked, not taken. Choosing a context or goal to scope the
	 * session to lands with home's Start slice; until then the session starts as the panel starts it.
	 */
	import { agentSession } from '$lib/agent/session.svelte';
	import type { LensProps } from '../../lenses';

	let _props: LensProps = $props();
</script>

<div class="start">
	<p class="line">
		Begin a session with an agent. Choosing a context or a goal to scope it to comes with a later
		build of home.
	</p>
	{#if agentSession.conversation}
		<button class="t-action" onclick={() => agentSession.setPanelOpen(true)}>
			a session is open — go to it <span aria-hidden="true">→</span>
		</button>
	{:else}
		<button class="t-action" onclick={() => agentSession.setPanelOpen(true)}>
			start a session <span aria-hidden="true">→</span>
		</button>
	{/if}
</div>

<style>
	.start {
		display: grid;
		gap: 0.6rem;
		padding: 1rem 1.1rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-panel);
		background: var(--tp-surface);
	}
	.line {
		margin: 0;
		font: 0.9rem var(--tp-font-ui);
		color: var(--tp-text-muted);
	}
	.t-action {
		justify-self: start;
		padding: 0;
	}
</style>
