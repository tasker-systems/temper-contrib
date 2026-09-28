<script lang="ts">
	import { agentSession } from '$lib/agent/session.svelte';
	import { askLabel } from '$lib/agent/reducers';
	import RegionState from '$lib/components/RegionState.svelte';
	import Transcript from '$lib/components/Transcript.svelte';
	import { enabled } from '$lib/shell/contributions';
	import { lensById } from '$lib/shell/lenses';
	import { stepTitle, tabs } from '$lib/shell/tabs.svelte';

	/** The agent panel: a view of the engagement store, holding no conversation
	 *  state of its own. Closing it hides the view — the store, the listeners
	 *  and the conversation carry on. */
	const session = agentSession;

	/** What the agent's own category reads as: its word, whatever it is.
	 *  `model_config` and `thought_level` carry their underscore; the words
	 *  are the agent's declared vocabulary, never a desktop rewrite. */
	/** The room in view: what the agent is shown with the next prompt, or why nothing is. */
	const inViewStep = $derived(tabs.current(tabs.active));
	const inViewLens = $derived(
		inViewStep.lens ? (lensById(inViewStep.lens, enabled)?.name ?? inViewStep.lens) : ''
	);
	const inViewShared = $derived(inViewStep.subject.kind === 'resource');

	function categoryLabel(category: string | null): string {
		return category ?? 'option';
	}
</script>

<aside class="panel" aria-label="Agent">
	<header class="head">
		<div class="head-row">
			<p class="t-label">the engagement</p>
			<button
				class="t-action close"
				aria-label="Close the agent panel"
				onclick={() => session.setPanelOpen(false)}
			>
				×</button
			>
		</div>
		<p class="who">
			<span class="agent-mark" aria-hidden="true">◆</span>
			{session.agentLabel() || 'no agent chosen'}{#if session.conversation}
				<span aria-hidden="true"> · </span>session
				<span class="strip-em">{session.conversation.sessionId}</span>{/if}
		</p>
		{#if session.conversation}
			<!-- Reach reads here, beneath the agent's name, whatever room is in view. -->
			<p class="t-strip reach">
				{#if session.selection.modes}
					mode ·
					{session.selection.modes.availableModes.find(
						(m) => m.id === session.selection.modes?.currentModeId
					)?.name ?? session.selection.modes.currentModeId}
				{:else}
					reach · the agent's own — the desktop relays what it asks, and doesn't limit what it writes
				{/if}
			</p>
		{/if}
	</header>

	<p class="in-view">
		{#if inViewShared}
			In view, shared with the agent:
		{:else}
			In view, not shared — a place is not a resource:
		{/if}
		<em>{stepTitle(inViewStep)}</em>
		{#if inViewLens}<span class="in-view-lens">· {inViewLens}</span>{/if}
	</p>

	{#if session.conversation}
		<div class="selection" aria-label="The agent's declared selection">
			{#if session.selection.modes}
				<div class="modes" role="group" aria-label="Modes the agent declared">
					<span class="t-strip">mode</span>
					{#each session.selection.modes.availableModes as mode (mode.id)}
						<button
							class="t-action"
							aria-pressed={session.selection.modes?.currentModeId === mode.id}
							title={mode.description ?? undefined}
							onclick={() => session.setMode(mode.id)}
						>
							{mode.name}
						</button>
					{/each}
				</div>
			{/if}
			{#each session.selection.configOptions as option (option.id)}
				{#if option.select}
					<label class="selector">
						<span class="t-strip">{option.name}{#if option.category}
								<span aria-hidden="true"> · </span>{categoryLabel(option.category)}{/if}</span>
						<select
							onchange={(e) =>
								option.select && session.setConfigOption(option.id, e.currentTarget.value)}
						>
							{#each option.select.options as choice (choice.value)}
								<option
									value={choice.value}
									selected={option.select.currentValue === choice.value}
								>
									{choice.name}
								</option>
							{/each}
						</select>
					</label>
				{:else if option.boolean}
					<label class="selector">
						<span class="t-strip">{option.name}</span>
						<input
							type="checkbox"
							checked={option.boolean.currentValue}
							onchange={(e) =>
								option.boolean && session.setConfigOption(option.id, e.currentTarget.checked)}
						/>
					</label>
				{/if}
			{/each}
		</div>
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
			{#each session.agents as agent (agent.key)}
				<button
					class="t-action"
					aria-pressed={session.agentKey === agent.key}
					onclick={() => session.selectAgent(agent.key)}
				>
					{agent.label}
				</button>
			{:else}
				<span class="t-strip">no agent is configured — add one in the settings room</span>
			{/each}
		</div>
		<label class="field">
			<span class="t-strip">Working directory</span>
			<input bind:value={session.workingDir} placeholder="/path/to/project" />
		</label>
		<button
			class="ed-action ed-action--primary"
			onclick={() => session.start()}
			disabled={session.starting || !session.agentKey}
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
		padding: 1.1rem 1.25rem 3rem;
		border-left: 1px solid var(--tp-rule);
		width: 23rem;
		box-sizing: border-box;
		background: var(--tp-surface);
		overflow-y: auto;
	}
	.head {
		display: grid;
		gap: 0.35rem;
		padding-bottom: 0.8rem;
		border-bottom: 1px solid var(--tp-rule);
	}
	.head-row {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}
	.head-row .t-label {
		flex: 1;
		margin: 0;
	}
	.in-view {
		margin: 0;
		font: 0.78rem var(--tp-font-ui);
		color: var(--tp-text-muted);
	}
	.in-view em {
		font: italic 0.85rem var(--tp-font-reading);
		color: var(--tp-text);
	}
	.in-view-lens {
		font: 0.62rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	.who {
		margin: 0;
		font: 0.8rem var(--tp-font-doing);
		color: var(--tp-text-muted);
	}
	.agent-mark {
		color: var(--tp-author-agent);
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
	.selector {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.selector select {
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		color: var(--tp-text);
		font: 0.85rem var(--tp-font-doing);
	}
	.selection {
		display: grid;
		gap: 0.5rem;
	}
	.modes {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.8rem;
	}
	.modes :global(button[aria-pressed='true']) {
		color: var(--tp-text);
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