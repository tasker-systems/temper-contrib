<script lang="ts">
	/**
	 * Home's Explore: the contexts the person can see, shown by their shape — the regions temper
	 * derived from what each holds, most salient first — rather than as folders. Three contexts, the
	 * most recently updated; one shape read each per show. A region's label is temper's; a region
	 * without one is called unlabelled, never named here.
	 *
	 * Seeing a context "as its shape" or "as a table" opens a tab through that lens. Neither lens is
	 * built yet, and each says so when opened — Explore does not pretend otherwise.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { untrack } from 'svelte';
	import RegionState from '$lib/components/RegionState.svelte';
	import { type TemperContext, temperViews } from '$lib/temper-views.svelte';
	import type { LensProps } from '../../lenses';
	import { tabs } from '../../tabs.svelte';

	let { shown = 0 }: LensProps = $props();

	/** How many contexts are shown. */
	const CONTEXTS = 3;
	/** How many region labels each card shows before saying how many more there are. */
	const LABELS = 3;

	type RegionView = { label: string | null; members: number };
	type Shape = {
		regions: RegionView[];
		population: number;
		emptiness: string | null;
		materializedAt: string | null;
	};
	type ShapeRead =
		| { state: 'arriving' }
		| { state: 'present'; shape: Shape }
		| { state: 'failed'; message: string };

	const allContexts = $derived(
		[...(temperViews.contexts ?? [])].sort((a, b) => b.updated.localeCompare(a.updated))
	);
	const contexts = $derived(allContexts.slice(0, CONTEXTS));
	/** What the cards leave out, in words — empty when they show every context. */
	const moreWords = $derived.by(() => {
		const more = allContexts.length - contexts.length;
		if (more <= 0) return '';
		return `${more} more ${more === 1 ? 'context is' : 'contexts are'} in the ways-in panel.`;
	});

	let shapes = $state<Record<string, ShapeRead>>({});
	let readShow = -1;

	$effect(() => {
		const show = shown;
		const these = contexts;
		// Read once per show, once the contexts are known.
		if (temperViews.contexts === null || show === readShow) return;
		readShow = show;
		untrack(() => {
			for (const context of these) void read(context, show);
		});
	});

	async function read(context: TemperContext, show: number): Promise<void> {
		if (!shapes[context.id]) shapes[context.id] = { state: 'arriving' };
		try {
			const shape = await invoke<Shape>('temper_context_shape', { contextId: context.id });
			if (show === readShow) shapes[context.id] = { state: 'present', shape };
		} catch (e) {
			// A read that fails after one landed keeps what landed.
			if (show === readShow && shapes[context.id]?.state !== 'present') {
				shapes[context.id] = { state: 'failed', message: String(e) };
			}
		}
	}

	const refOf = (context: TemperContext) => `${context.ownerRef}/${context.slug}`;

	/** Why a context shows no regions, in words — temper's reason, never a guess. */
	function emptyWords(emptiness: string | null): string {
		switch (emptiness) {
			case 'never_clustered':
				return 'not yet clustered — temper hasn’t derived regions here';
			case 'nothing_visible':
				return 'no regions you can read';
			case 'unreadable_or_absent':
				return 'its shape can’t be read here';
			default:
				return 'no regions';
		}
	}

	/** The card's counts: resources always; regions once a shape with some has been read. */
	function counts(context: TemperContext, read: ShapeRead): string {
		const regions =
			read.state === 'present' && read.shape.population > 0
				? ` · ${read.shape.population} regions`
				: '';
		return `${context.resourceCount} resources${regions}`;
	}

	const regionWords = (region: RegionView) =>
		region.label ?? `an unlabelled region of ${region.members}`;

	function open(context: TemperContext, lens: 'core/shape' | 'core/table'): void {
		tabs.open({ kind: 'query', context: refOf(context) }, { where: 'new', lens });
	}
</script>

{#if temperViews.contexts === null}
	<RegionState
		state={temperViews.contextsError ? 'failed' : 'arriving'}
		label="your contexts"
		detail={temperViews.contextsError || null}
	/>
{:else if contexts.length === 0}
	<RegionState
		state="empty"
		label="contexts you can see"
		detail="Contexts you or your teams hold appear here, shown by the regions temper derives from them."
	/>
{:else}
	<div class="explore">
		{#each contexts as context (context.id)}
			{@const read = shapes[context.id] ?? { state: 'arriving' }}
			<div class="card" data-context={refOf(context)}>
				<p class="head">
					<span class="ref">{refOf(context)}</span>
					<span class="counts">{counts(context, read)}</span>
				</p>
				{#if read.state === 'arriving'}
					<RegionState state="arriving" label="its shape" />
				{:else if read.state === 'failed'}
					<RegionState state="failed" label="its shape" detail={read.message} />
				{:else if read.shape.regions.length === 0}
					<p class="empty">{emptyWords(read.shape.emptiness)}</p>
				{:else}
					{@const labels = read.shape.regions.slice(0, LABELS)}
					<ul class="regions">
						{#each labels as region, i (i)}
							<li class:unlabelled={region.label === null}>{regionWords(region)}</li>
						{/each}
						{#if read.shape.population > labels.length}
							<li class="more">+{read.shape.population - labels.length} more</li>
						{/if}
					</ul>
				{/if}
				<div class="ways">
					<button class="t-action" onclick={() => open(context, 'core/shape')}>
						its shape <span aria-hidden="true">→</span>
					</button>
					<button class="t-action" onclick={() => open(context, 'core/table')}>
						as a table <span aria-hidden="true">→</span>
					</button>
				</div>
			</div>
		{/each}
		<p class="foot">
			Regions are what temper derived from what the context holds — orientation without folders.
			{moreWords}
		</p>
	</div>
{/if}

<style>
	.explore {
		display: grid;
		gap: 0.6rem;
		/* Track clamp: this section bounds the rows it holds; a nowrap title inside must
		   not widen the column past the room. */
		min-width: 0;
	}
	.card {
		display: grid;
		gap: 0.5rem;
		padding: 0.9rem 1.1rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-panel);
		background: var(--tp-surface);
	}
	.head {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin: 0;
	}
	.ref {
		font: 0.9rem var(--tp-font-doing);
		color: var(--tp-text);
	}
	.counts {
		font: 0.78rem var(--tp-font-ui);
		color: var(--tp-text-subtle);
	}
	.regions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.regions li {
		padding: 0.2rem 0.55rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface-raised);
		font: italic 0.85rem var(--tp-font-reading);
		color: var(--tp-text);
	}
	.regions li.unlabelled,
	.regions li.more {
		color: var(--tp-text-subtle);
	}
	.regions li.more {
		border-style: dashed;
		font-style: normal;
		font-family: var(--tp-font-ui);
	}
	.empty,
	.foot {
		margin: 0;
		font: italic 0.85rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
	.ways {
		display: flex;
		gap: 1.2rem;
	}
	.ways .t-action {
		padding: 0;
	}
</style>
