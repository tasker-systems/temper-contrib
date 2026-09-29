<script lang="ts">
	/**
	 * temper-workflows' "recently updated", pinned to home under Awaiting you: what changed most
	 * recently in the contexts the person actually worked in — the homes of their latest places in
	 * the hub. When the hub has nothing yet, it falls back to everything visible, and says so.
	 *
	 * It never says "since you last engaged": that needs temper's event feed, which does not exist
	 * yet (ruling F). Until then it says "recently updated", and always how much it shows of how
	 * much there is.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import BoundedList from '$lib/components/BoundedList.svelte';
	import RegionState from '$lib/components/RegionState.svelte';
	import { roomHref } from '$lib/document';
	import { getRefResolver } from '$lib/refs';
	import { ageWords, type TemperRecentPage, type TemperRecentRow } from '$lib/temper-views.svelte';
	import { homeReads } from '../../home-reads.svelte';
	import type { LensProps } from '../../lenses';

	let { shown = 0 }: LensProps = $props();

	/** How many rows are shown. */
	const ROWS = 5;
	/** How many of the latest places' homes are read. */
	const PLACES = 5;
	/** How many contexts are read, at most. */
	const CONTEXTS = 3;

	type Recent =
		| { state: 'arriving' }
		| {
				state: 'present';
				rows: TemperRecentRow[];
				total: number;
				contexts: string[] | null;
				/** Why everything visible was read instead: the hub was empty, or could not be read. */
				hubRead: boolean;
		  }
		| { state: 'failed'; message: string };

	let recent = $state<Recent>({ state: 'arriving' });
	let readShow = -1;
	const resolver = getRefResolver();

	$effect(() => {
		homeReads.readRecent(shown);
	});

	// Once the hub has answered for this show, read the contexts it points to — once.
	$effect(() => {
		const hub = homeReads.recent;
		const show = shown;
		if (hub.state === 'arriving' || show === readShow) return;
		readShow = show;
		const places = hub.state === 'present' ? hub.data.entries.slice(0, PLACES) : [];
		void read(places.map((p) => p.resource), hub.state === 'present', show);
	});

	async function homesOf(resources: string[]): Promise<string[]> {
		const answers = await Promise.all(resources.map((id) => resolver.resolve(id)));
		const homes: string[] = [];
		for (const a of answers) {
			if (a.state === 'resolved' && a.contextRef && !homes.includes(a.contextRef)) homes.push(a.contextRef);
		}
		return homes.slice(0, CONTEXTS);
	}

	async function read(resources: string[], hubRead: boolean, show: number): Promise<void> {
		try {
			const contexts = await homesOf(resources);
			let rows: TemperRecentRow[];
			let total: number;
			if (contexts.length) {
				const pages = await Promise.all(
					contexts.map((contextRef) =>
						invoke<TemperRecentPage>('temper_list_resources', {
							filter: { contextRef },
							limit: ROWS,
							offset: 0
						})
					)
				);
				rows = pages
					.flatMap((p) => p.rows)
					.sort((a, b) => b.updated.localeCompare(a.updated))
					.slice(0, ROWS);
				total = pages.reduce((sum, p) => sum + p.total, 0);
			} else {
				const page = await invoke<TemperRecentPage>('temper_recent_work', { limit: ROWS, offset: 0 });
				rows = page.rows;
				total = page.total;
			}
			if (show === readShow) {
				recent = { state: 'present', rows, total, contexts: contexts.length ? contexts : null, hubRead };
			}
		} catch (e) {
			if (show === readShow && recent.state !== 'present') recent = { state: 'failed', message: String(e) };
		}
	}

	const scope = $derived.by(() => {
		if (recent.state !== 'present') return '';
		if (recent.contexts) return `recently updated in ${recent.contexts.join(', ')}, where you worked last`;
		return recent.hubRead
			? 'recently updated wherever you can see — nothing you worked in is recorded yet'
			: 'recently updated wherever you can see — where you worked could not be read';
	});
</script>

{#if recent.state === 'arriving'}
	<RegionState state="arriving" label="what was recently updated" />
{:else if recent.state === 'failed'}
	<RegionState state="failed" label="what was recently updated" detail={recent.message} />
{:else}
	<div class="recent">
		<p class="t-strip heading">{scope}</p>
		<BoundedList
			label="recent updates"
			scope="recently updated"
			state="present"
			total={recent.total}
			shown={recent.rows.length}
		>
			{#each recent.rows as row (row.id)}
				<a class="entry" href={roomHref(row.decoratedRef)} title={row.title}>
					<span class="type">{row.docType}</span>
					<span class="main">{row.title}</span>
					<span class="sub">{ageWords(Date.parse(row.updated))}</span>
				</a>
			{/each}
		</BoundedList>
		<p class="honest">
			“Since you last engaged” needs temper’s event feed; until then this says recently updated.
		</p>
	</div>
{/if}

<style>
	.recent {
		display: grid;
		gap: 0.3rem;
		/* Track clamp: the section's rows bound to it, never hold it at a nowrap chip's width. */
		min-width: 0;
	}
	.heading,
	.honest {
		margin: 0;
	}
	.honest {
		font: italic 0.8rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
	.entry {
		text-decoration: none;
	}
	.type {
		flex: none;
		font: 0.56rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-label);
		text-transform: uppercase;
		color: var(--tp-text-subtle);
	}
	.main {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: italic 0.88rem var(--tp-font-reading);
		color: var(--tp-text);
	}
	.sub {
		flex: none;
		font-size: 0.78rem;
		color: var(--tp-text-subtle);
	}
</style>
