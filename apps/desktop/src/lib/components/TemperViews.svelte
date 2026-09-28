<script lang="ts">
	import { roomHref } from '$lib/document';
	import { contextHref } from '$lib/shell/subjects';
	import { ageWords, temperViews } from '$lib/temper-views.svelte';
	import BoundedList from './BoundedList.svelte';
	import type { RegionStateName } from './RegionState.svelte';

	/**
	 * The temper views on the home room: teams, contexts, and the bounded
	 * recent-work list. Every list says what it omits and, when it is
	 * rendering cached reads, says their age — read-only, never a crash.
	 */
	const v = temperViews;

	type ListState = 'present' | RegionStateName;
	const listState = (data: unknown, error: string): ListState => {
		if (data !== null) return 'present';
		if (error) return 'failed';
		return 'arriving';
	};

	const dateWords = (rfc3339: string): string => rfc3339.slice(0, 10);
</script>

<section class="views">
	<p class="t-label">Teams</p>
	<BoundedList
		label="teams"
		scope="of your teams"
		state={listState(v.teams, v.teamsError)}
		total={v.teams?.length ?? 0}
		shown={v.teams?.length ?? 0}
	>
		{#each v.teams ?? [] as team (team.id)}
			<span class="entry">
				<span class="main">{team.name}</span>
				<span class="sub">
					{[team.description, `+${team.slug}`].filter(Boolean).join(' · ')}
				</span>
			</span>
		{/each}
	</BoundedList>
	{#if v.teams !== null && !v.teamsFresh && v.teamsFetchedAt !== null}
		<p class="cache-age">from cache, {ageWords(v.teamsFetchedAt)}</p>
	{/if}

	<p class="t-label">Contexts</p>
	<BoundedList
		label="contexts"
		scope="of the contexts your temper credentials can see"
		state={listState(v.contexts, v.contextsError)}
		total={v.contexts?.length ?? 0}
		shown={v.contexts?.length ?? 0}
	>
		{#each v.contexts ?? [] as context (context.id)}
			<a class="entry" href={contextHref(`${context.ownerRef}/${context.slug}`)}>
				<span class="main">{context.ownerRef}/{context.slug}</span>
				<span class="sub">
					{context.name} · {context.resourceCount} {context.resourceCount === 1 ? 'resource' : 'resources'}
				</span>
			</a>
		{/each}
	</BoundedList>
	{#if v.contexts !== null && !v.contextsFresh && v.contextsFetchedAt !== null}
		<p class="cache-age">from cache, {ageWords(v.contextsFetchedAt)}</p>
	{/if}

	<p class="t-label">Recent work</p>
	<BoundedList
		label="recent work"
		scope="recently updated resources your temper credentials can see"
		state={listState(v.recent, v.recentError)}
		total={v.recent?.total ?? 0}
		shown={v.recent?.rows.length ?? 0}
		more={v.recent && v.recent.rows.length < v.recent.total ? { step: 10 } : null}
		onmore={() => v.showMoreRecent()}
	>
		{#each v.recent?.rows ?? [] as row (row.id)}
			<a class="entry" href={roomHref(row.decoratedRef)}>
				<span class="main">{row.title}</span>
				<span class="sub">
					{row.docType}{#if row.contextRef} · {row.contextRef}{/if} · {dateWords(row.updated)}
				</span>
			</a>
		{/each}
	</BoundedList>
	{#if v.recent !== null && !v.recentFresh && v.recentFetchedAt !== null}
		<p class="cache-age">from cache, {ageWords(v.recentFetchedAt)}</p>
	{/if}
</section>

<style>
	.views {
		display: grid;
		gap: 0.8rem;
	}
	.entry {
		display: grid;
		gap: 0.1rem;
	}
	a.entry {
		text-decoration: none;
	}
	a.entry:hover .main {
		color: var(--tp-accent);
	}
	.main {
		color: var(--tp-text);
	}
	.sub {
		font-size: 0.78rem;
		color: var(--tp-text-subtle);
	}
	.cache-age {
		margin: -0.4rem 0 0;
		font: italic 0.8rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
</style>
