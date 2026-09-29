<script lang="ts">
	/**
	 * Home's "Awaiting you", the agent's half: every ask the agent has put to the person, each a
	 * link into the agent panel. It never opens the panel by itself — attention is asked, not taken
	 * — so a pending ask waits here, and on the agent toggle, until the person goes to it.
	 */
	import { tick } from 'svelte';
	import { agentSession } from '$lib/agent/session.svelte';
	import { askLabel, type AskedNotice } from '$lib/agent/reducers';
	import type { LensProps } from '../../lenses';

	let _props: LensProps = $props();

	/** The person's gesture: open the panel, and put focus on the ask they chose. */
	async function goTo(ask: AskedNotice) {
		agentSession.setPanelOpen(true);
		await tick();
		document.querySelector<HTMLElement>(`[data-ask="${CSS.escape(ask.askId)}"]`)?.focus();
	}
</script>

{#if agentSession.asks.length}
	<ul class="asks">
		{#each agentSession.asks as ask (ask.askId)}
			<li>
				<button class="ask" onclick={() => goTo(ask)}>
					<span class="mark" aria-hidden="true">◇</span>
					<span>
						{agentSession.agentLabel()} asks to run <span class="what">{askLabel(ask)}</span>
						<span class="where">— answer it in the agent panel</span>
					</span>
				</button>
			</li>
		{/each}
	</ul>
{:else}
	<p class="none">
		<span aria-hidden="true">—</span>
		{agentSession.conversation
			? 'Nothing is waiting on you from the agent.'
			: 'No agent session is open, so nothing is waiting on you from an agent.'}
	</p>
{/if}

<style>
	.asks {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
		/* Track clamp: this section bounds the rows it holds; a nowrap title inside must
		   not widen the column past the room. */
		min-width: 0;
	}
	.ask {
		display: flex;
		gap: 0.6rem;
		width: 100%;
		padding: 0.7rem 0.9rem;
		border: 1px solid var(--tp-pending);
		border-radius: var(--tp-radius-panel);
		background: var(--tp-pending-wash);
		font: 0.9rem var(--tp-font-ui);
		color: var(--tp-text);
		text-align: left;
		cursor: pointer;
	}
	.ask:hover {
		border-color: var(--tp-accent-line);
	}
	.mark {
		color: var(--tp-pending);
	}
	.what {
		font-family: var(--tp-font-doing);
	}
	.none {
		margin: 0;
		font: italic 0.9rem var(--tp-font-reading);
		color: var(--tp-text-muted);
	}
</style>
