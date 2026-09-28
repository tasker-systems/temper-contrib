<script lang="ts">
	/**
	 * The left panel: ways in, grouped by the plugin that contributed each entry, in the order the
	 * contributions are registered. Never folders — each entry is a bounded read that says what it
	 * omits, and every row is a link that opens its subject through the shell's one door (in this
	 * tab, or a new one on ⌘/Ctrl or middle click; from home, always a new tab).
	 *
	 * The panel reads its lists once, the first time it is shown. Closing it hides it; reopening
	 * re-reads nothing. The foot names the enabled plugins and, when any list is drawn from the
	 * device cache, how old that cache is.
	 */
	import BoundedList from '$lib/components/BoundedList.svelte';
	import type { RegionStateName } from '$lib/components/RegionState.svelte';
	import { roomHref } from '$lib/document';
	import {
		ageWords,
		LIST_STEP,
		type ListView,
		type TemperRecentPage,
		temperViews
	} from '$lib/temper-views.svelte';
	import { enabled } from './contributions';
	import type { WayInDecl } from './lenses';
	import { contextHref } from './subjects';

	const v = temperViews;
	const groups = enabled.filter((c) => c.waysIn.length > 0);
	const listKey = (plugin: string, way: WayInDecl) => `${plugin}/${way.id}`;

	// One read per list, on first show. The recent-work and context reads are shared with home.
	for (const group of groups) {
		for (const way of group.waysIn) {
			if (way.source === 'list') void v.refreshList(listKey(group.plugin, way), way.filter);
		}
	}

	/** How many contexts are shown; contexts are read whole, so showing more reads nothing. */
	let contextsShown = $state(LIST_STEP);

	type ListState = 'present' | RegionStateName;
	const stateOf = (data: unknown, error: string): ListState =>
		data !== null ? 'present' : error ? 'failed' : 'arriving';

	/** The oldest cache age any rendered list is drawn from, or null when every list is fresh. */
	const cachedAt = $derived.by(() => {
		const ages: number[] = [];
		if (v.contexts !== null && !v.contextsFresh && v.contextsFetchedAt !== null)
			ages.push(v.contextsFetchedAt);
		if (v.recent !== null && !v.recentFresh && v.recentFetchedAt !== null)
			ages.push(v.recentFetchedAt);
		for (const group of groups) {
			for (const way of group.waysIn) {
				if (way.source !== 'list') continue;
				const l = v.list(listKey(group.plugin, way));
				if (l.page !== null && !l.fresh && l.fetchedAt !== null) ages.push(l.fetchedAt);
			}
		}
		return ages.length ? Math.min(...ages) : null;
	});
</script>

{#snippet rows(page: TemperRecentPage | null)}
	{#each page?.rows ?? [] as row (row.id)}
		<a class="entry" href={roomHref(row.decoratedRef)} title={row.title}>
			<span class="main">{row.title}</span>
			<span class="sub">{row.docType}</span>
		</a>
	{/each}
{/snippet}

<nav class="ways-in" aria-label="Ways in">
	<div class="groups">
		{#each groups as group (group.plugin)}
			<section class="group" aria-label={`Ways in from ${group.plugin}`}>
				{#each group.waysIn as way (way.id)}
					<div class="way">
						<p class="head">
							<span class="t-label">{way.label}</span>
							<span class="plugin">{group.plugin}</span>
						</p>
						{#if way.source === 'contexts'}
							<BoundedList
								label={way.label}
								scope={way.scope}
								state={stateOf(v.contexts, v.contextsError)}
								total={v.contexts?.length ?? 0}
								shown={Math.min(contextsShown, v.contexts?.length ?? 0)}
								more={{ step: LIST_STEP }}
								onmore={() => (contextsShown += LIST_STEP)}
							>
								{#each (v.contexts ?? []).slice(0, contextsShown) as context (context.id)}
									<a class="entry" href={contextHref(`${context.ownerRef}/${context.slug}`)}>
										<span class="main">{context.ownerRef}/{context.slug}</span>
										<span class="sub">{context.resourceCount}</span>
									</a>
								{/each}
							</BoundedList>
						{:else if way.source === 'recent'}
							<BoundedList
								label={way.label}
								scope={way.scope}
								state={stateOf(v.recent, v.recentError)}
								total={v.recent?.total ?? 0}
								shown={v.recent?.rows.length ?? 0}
								more={{ step: 10 }}
								onmore={() => v.showMoreRecent()}
							>
								{@render rows(v.recent)}
							</BoundedList>
						{:else}
							{@const list: ListView = v.list(listKey(group.plugin, way))}
							<BoundedList
								label={way.label}
								scope={way.scope}
								state={stateOf(list.page, list.error)}
								total={list.page?.total ?? 0}
								shown={list.page?.rows.length ?? 0}
								more={{ step: LIST_STEP }}
								onmore={() => v.showMoreList(listKey(group.plugin, way), way.filter)}
							>
								{@render rows(list.page)}
							</BoundedList>
						{/if}
					</div>
				{/each}
			</section>
		{/each}
	</div>
	<p class="foot">
		{enabled.length} plugins enabled · {enabled.map((c) => c.plugin).join(', ')}
		{#if cachedAt !== null}
			<span class="t-slot-cacheAge">· from cache, {ageWords(cachedAt)}</span>
		{/if}
	</p>
</nav>

<style>
	.ways-in {
		display: flex;
		flex-direction: column;
		width: 16rem;
		height: 100%;
		box-sizing: border-box;
		border-right: 1px solid var(--tp-rule);
		background: var(--tp-surface);
	}
	.groups {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.9rem 1.1rem;
		display: grid;
		align-content: start;
		gap: 1.2rem;
	}
	.group {
		display: grid;
		gap: 1rem;
	}
	.way {
		display: grid;
		gap: 0.4rem;
	}
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		margin: 0;
	}
	.head .t-label {
		margin: 0;
	}
	.plugin {
		font: 0.56rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-strip);
		color: var(--tp-text-subtle);
	}
	.entry {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		min-width: 0;
		padding: 0.15rem 0;
		text-decoration: none;
	}
	.main {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 0.8rem var(--tp-font-ui);
		color: var(--tp-text);
	}
	.entry:hover .main {
		color: var(--tp-accent);
	}
	.sub {
		flex: none;
		font: 0.6rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	.foot {
		margin: 0;
		padding: 0.7rem 1.1rem;
		border-top: 1px solid var(--tp-rule);
		font: 0.6rem/1.6 var(--tp-font-doing);
		letter-spacing: 0.08em;
		color: var(--tp-text-subtle);
	}
</style>
