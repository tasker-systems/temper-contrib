<script lang="ts">
	/**
	 * The document's history, newest first, in runs by who acted. Adapted from temper-ui's
	 * EventHistory.svelte (tasker-systems/temper, packages/temper-ui/src/lib/components/vault/EventHistory.svelte,
	 * at ee12cd5): the bound is stated chrome, and the grouping is the core's (`doc_history`), so
	 * an agent's run of small edits never buries the one edit a person made between them.
	 *
	 * Archaeology, not a feed: a run's events open on request.
	 */
	import type { History } from '$lib/document';
	import { ageWords } from '$lib/temper-views.svelte';
	import BoundedList from './BoundedList.svelte';

	let { history }: { history: History } = $props();

	let open = $state<number | null>(null);
	const ago = (rfc3339: string) => ageWords(Date.parse(rfc3339));
</script>

<BoundedList
	label="history"
	scope="events in this document's history, newest first"
	state="present"
	total={history.total}
	shown={history.total - history.omitted}
>
	{#each history.runs as run, i (i)}
		<div class="run">
			<button class="head" aria-expanded={open === i} onclick={() => (open = open === i ? null : i)}>
				<span class="actor">{run.actorName}</span>
				<span class="meta">
					{run.acts}
					{run.acts === 1 ? 'act' : 'acts'} · {run.firstAt === run.lastAt
						? ago(run.lastAt)
						: `${ago(run.firstAt)} – ${ago(run.lastAt)}`}
				</span>
				<span class="chev" aria-hidden="true">{open === i ? '⌄' : '›'}</span>
			</button>
			{#if open === i}
				<ol class="events">
					{#each run.events as event (event.eventId)}
						<li>
							<span class="kind">{event.kind}</span>
							<time datetime={event.occurredAt} title={event.occurredAt}>{ago(event.occurredAt)}</time>
						</li>
					{/each}
				</ol>
			{/if}
		</div>
	{/each}
</BoundedList>

<style>
	.run {
		display: grid;
		gap: 0.3rem;
	}
	.head {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		width: 100%;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		text-align: left;
	}
	.actor {
		color: var(--tp-text);
		font: 0.85rem var(--tp-font-ui);
	}
	.meta,
	.chev {
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	.chev {
		margin-left: auto;
	}
	.events {
		margin: 0;
		padding-left: 0.8rem;
		border-left: 1px solid var(--tp-accent-line-soft);
		list-style: none;
	}
	.events li {
		display: flex;
		gap: 0.6rem;
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text-muted);
	}
	time {
		color: var(--tp-text-subtle);
	}
</style>
