<script lang="ts">
	/**
	 * Home's "Start": begin a session with an agent, scoped to a context or a goal (ruling B). The
	 * scope goes to the agent with the first prompt, and the work record written at close links it;
	 * the record itself lives in the person's context. Starting is the person's gesture, so opening
	 * the agent panel here is asked, not taken.
	 *
	 * The choices are what the desktop already holds — the contexts, and the active goals the ways-in
	 * panel lists — read once per show when nothing is held yet. The scope last started with on this
	 * device is offered first.
	 */
	import { agentSession, type SessionScope } from '$lib/agent/session.svelte';
	import { temperViews } from '$lib/temper-views.svelte';
	import type { LensProps } from '../../lenses';
	import { placeHref } from '../../subjects';

	let { shown = 0 }: LensProps = $props();

	/** The active-goals list the ways-in panel reads — shared, so one read serves both. */
	const GOALS_KEY = 'temper-workflows/goals';
	const GOALS_FILTER = { docType: 'goal', status: 'active' };

	let lastShow = -1;
	$effect(() => {
		if (shown === lastShow) return;
		lastShow = shown;
		if (temperViews.list(GOALS_KEY).page === null) void temperViews.refreshList(GOALS_KEY, GOALS_FILTER);
	});

	const key = (scope: SessionScope) => `${scope.kind}|${scope.ref}`;

	const contexts = $derived<SessionScope[]>(
		[...(temperViews.contexts ?? [])]
			.sort((a, b) => b.updated.localeCompare(a.updated))
			.map((c) => {
				const ref = `${c.ownerRef}/${c.slug}`;
				return { kind: 'context', ref, name: ref };
			})
	);
	const goalsPage = $derived(temperViews.list(GOALS_KEY).page);
	const goals = $derived<SessionScope[]>(
		(goalsPage?.rows ?? []).map((g) => ({ kind: 'goal', ref: g.decoratedRef, name: g.title }))
	);
	const goalsOmitted = $derived(Math.max(0, (goalsPage?.total ?? 0) - goals.length));
	const choices = $derived(new Map([...contexts, ...goals].map((s) => [key(s), s])));

	/** The chosen scope's key; empty is no scope. Starts on the last scope when it is still offered. */
	let chosen = $state('');
	let touched = false;
	$effect(() => {
		const last = agentSession.lastScope;
		if (!touched && last && choices.has(key(last))) chosen = key(last);
	});

	async function start(): Promise<void> {
		await agentSession.start({ scope: choices.get(chosen) ?? null });
		if (agentSession.conversation) agentSession.setPanelOpen(true);
	}
</script>

<div class="start">
	<p class="line">
		Begin a session with an agent, scoped to a context or a goal. What you make together is linked
		there.
	</p>

	{#if agentSession.conversation}
		<p class="live">
			A session is open{#if agentSession.scope}, scoped to the {agentSession.scope.kind}
				<span class="scope-name">{agentSession.scope.name}</span>{/if}.
		</p>
		<button class="t-action go" onclick={() => agentSession.setPanelOpen(true)}>
			go to the session <span aria-hidden="true">→</span>
		</button>
	{:else if agentSession.agents.length === 0}
		<p class="live">
			No agent is configured — <a class="t-action" href={placeHref('settings')}>add one in settings</a>.
		</p>
	{:else}
		<div class="fields">
			<label class="field">
				<span class="t-strip">agent</span>
				<select
					value={agentSession.agentKey}
					onchange={(e) => agentSession.selectAgent(e.currentTarget.value)}
				>
					{#each agentSession.agents as agent (agent.key)}
						<option value={agent.key}>{agent.label}</option>
					{/each}
				</select>
			</label>
			<label class="field">
				<span class="t-strip">scoped to</span>
				<select
					bind:value={chosen}
					onchange={() => {
						touched = true;
					}}
				>
					<option value="">nothing in particular</option>
					{#if contexts.length}
						<optgroup label="Contexts">
							{#each contexts as scope (key(scope))}
								<option value={key(scope)}>{scope.name}</option>
							{/each}
						</optgroup>
					{/if}
					{#if goals.length}
						<optgroup label="Active goals">
							{#each goals as scope (key(scope))}
								<option value={key(scope)}>{scope.name}</option>
							{/each}
							{#if goalsOmitted > 0}
								<option disabled>{goalsOmitted} more active goals — in the ways-in panel</option>
							{/if}
						</optgroup>
					{/if}
				</select>
			</label>
			<label class="field wide">
				<span class="t-strip">working directory</span>
				<input bind:value={agentSession.workingDir} placeholder="/path/to/project" />
			</label>
		</div>
		<button class="t-action go" onclick={start} disabled={agentSession.starting}>
			{agentSession.starting ? 'starting…' : 'start session'} <span aria-hidden="true">→</span>
		</button>
		{#if agentSession.error}
			<p class="error" role="alert">{agentSession.error}</p>
		{/if}
	{/if}
</div>

<style>
	.start {
		display: grid;
		gap: 0.7rem;
		padding: 1rem 1.1rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-panel);
		background: var(--tp-surface);
		/* Track clamp: this section bounds the rows it holds; a nowrap title inside must
		   not widen the column past the room. */
		min-width: 0;
	}
	.line,
	.live,
	.error {
		margin: 0;
		font: 0.9rem var(--tp-font-ui);
		color: var(--tp-text-muted);
	}
	.scope-name {
		color: var(--tp-text);
	}
	.error {
		color: var(--tp-danger);
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.6rem 1rem;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	.wide {
		grid-column: 1 / -1;
	}
	select,
	input {
		min-width: 0;
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface-raised);
		font: 0.85rem var(--tp-font-ui);
		color: var(--tp-text);
	}
	input {
		font-family: var(--tp-font-doing);
	}
	.go {
		justify-self: start;
		padding: 0;
	}
</style>
