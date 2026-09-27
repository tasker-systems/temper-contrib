<script lang="ts">
	import { AGENTS, agentSession } from '$lib/agent/session.svelte';
	import { askLabel } from '$lib/agent/reducers';
	import RegionState from '$lib/components/RegionState.svelte';
	import Transcript from '$lib/components/Transcript.svelte';

	/** The agent panel: a view of the engagement store, holding no conversation
	 *  state of its own. Closing it hides the view — the store, the listeners
	 *  and the conversation carry on. */
	const session = agentSession;
</script>

<aside class="panel" aria-label="Agent">
	<header class="head">
		<p class="t-label">
			{#if session.conversation}
				{session.agentLabel()} <span aria-hidden="true">·</span> session
				<span class="strip-em">{session.conversation.sessionId}</span>
			{:else}
				{session.agentLabel()}
			{/if}
		</p>
		<button
			class="t-action close"
			aria-label="Close the agent panel"
			onclick={() => session.setPanelOpen(false)}
		>
			×</button
		>
	</header>

	{#if session.conversation}
		<p class="t-strip reach">reach · the agent's own — the desktop relays what it asks, and doesn't limit what it writes</p>
		<Transcript messages={session.messages} pending={session.prompting ? session.agentLabel() : null} />
		{#each session.asks as ask (ask.askId)}
			<section class="ask" aria-label="Permission requested" aria-busy="true">
				<p class="t-strip">asked to run <span aria-hidden="true">·</span> waiting for your answer</p>
				<p class="ask-what">{askLabel(ask)}</p>
				{#if ask.toolCall.rawInput !== undefined && ask.toolCall.rawInput !== null}
					<pre class="ask-input">{JSON.stringify(ask.toolCall.rawInput, null, 2)}</pre>
				{/if}
				<div class="ask-options" role="group" aria-label="Declared options">
					{#each ask.options as option (option.optionId)}
						<button class="t-action ask-option" onclick={() => session.answer(ask, option)}>
							{option.name} <span class="ask-kind">{option.kind}</span>
						</button>
					{/each}
				</div>
			</section>
		{/each}
		<form
			class="composer"
			onsubmit={(event) => {
				event.preventDefault();
				session.send();
			}}
		>
			<input
				bind:value={session.draft}
				placeholder={session.prompting ? 'agent is responding…' : 'type a message'}
			/>
			<button
				class="ed-action ed-action--primary"
				type="submit"
				disabled={session.prompting || !session.draft.trim()}
			>
				Send
			</button>
		</form>
		<button class="ed-action ed-action--ghost" onclick={() => session.close()}>End conversation</button>
	{:else}
		<div class="agents" role="group" aria-label="Agent">
			<span class="t-strip">Agent</span>
			{#each AGENTS as agent (agent.command)}
				<button
					class="t-action"
					aria-pressed={session.agentCommand === agent.command}
					onclick={() => (session.agentCommand = agent.command)}
				>
					{agent.label}
				</button>
			{/each}
		</div>
		<label class="field">
			<span class="t-strip">Working directory</span>
			<input bind:value={session.workingDir} placeholder="/path/to/project" />
		</label>
		<button
			class="ed-action ed-action--primary"
			onclick={() => session.start()}
			disabled={session.starting || !session.agentCommand.trim()}
		>
			{session.starting ? `Starting ${session.agentLabel()}…` : 'Start conversation'}
		</button>
	{/if}

	{#if session.error}
		<RegionState state="failed" label="the last request" detail={session.error} />
	{/if}
</aside>

<style>
	.panel {
		display: grid;
		gap: 0.8rem;
		align-content: start;
		padding: 1.5rem 1.25rem 3rem;
		border-left: 1px solid var(--tp-rule-strong);
		min-width: 20rem;
		max-width: 24rem;
		height: 100%;
		overflow-y: auto;
	}
	.head {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}
	.head .t-label {
		flex: 1;
		margin: 0;
	}
	.strip-em {
		font-family: var(--tp-font-doing);
	}
	.reach {
		margin: 0;
		color: var(--tp-text-muted);
	}
	.agents {
		display: flex;
		align-items: baseline;
		gap: 1rem;
	}
	.agents :global(button[aria-pressed='true']) {
		color: var(--tp-text);
	}
	.field {
		display: grid;
		gap: 0.4rem;
		width: 100%;
	}
	input {
		box-sizing: border-box;
		width: 100%;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		color: var(--tp-text);
		font: 0.85rem var(--tp-font-doing);
	}
	input:focus {
		border-color: var(--tp-accent-line);
		outline: none;
	}
	.composer {
		display: flex;
		gap: 0.8rem;
		align-items: center;
		width: 100%;
	}
	.composer input {
		flex: 1;
	}
	.ask {
		display: grid;
		gap: 0.6rem;
		width: 100%;
		padding: 0.8rem;
		border: 1px solid var(--tp-accent-line);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
	}
	.ask-what {
		margin: 0;
		color: var(--tp-text);
	}
	.ask-input {
		margin: 0;
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		color: var(--tp-text-muted);
		font: 0.8rem var(--tp-font-doing);
		white-space: pre-wrap;
		word-break: break-word;
	}
	.ask-options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.ask-kind {
		opacity: 0.6;
		font-size: 0.85em;
	}
</style>