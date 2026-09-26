<script lang="ts">
	/**
	 * The catalog, rendered through the real renderer from specs: the in-app counterpart to
	 * themes/preview/. Every block below is a json-render spec checked by TemperView.
	 */
	import { CATALOG_VERSION } from '$lib/catalog/catalog';
	import TemperView from '$lib/catalog/TemperView.svelte';
	import { setRefResolver, tauriResolver } from '$lib/refs';
	import { activitySpec, fixtureResolver, refsSpec, refusedSpec, regionSpecs } from './fixtures';

	const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
	const resolver = inTauri ? tauriResolver : fixtureResolver;
	setRefResolver(resolver);

	let shown = $state(2);
	const activity = $derived(activitySpec(shown));
	const handlers = { showMore: () => { shown = Math.min(shown + 1, 4); } };
</script>

<main class="page">
	<div class="ed-strip">
		<span>catalog</span><span class="ed-strip-sep">·</span><span class="ed-strip-em">{CATALOG_VERSION}</span>
		<span class="ed-strip-spacer"></span>
		<span class={resolver.source === 'fixtures' ? 'ed-strip-accent' : ''}>
			refs resolved from {resolver.source === 'fixtures' ? 'fixtures — not running in the app shell' : 'temper'}
		</span>
	</div>

	<h1 class="t-h2">The <em>room</em> — rendered from specs</h1>

	<p class="t-label">Region state</p>
	<section class="ed-rail stack">
		{#each regionSpecs as spec, i (i)}<TemperView {spec} />{/each}
	</section>

	<p class="t-label">Bounded list · since last engaged</p>
	<section class="ed-rail">
		<TemperView spec={activity} {handlers} />
	</section>

	<p class="t-label">Resource refs · resolved, arriving, unresolved</p>
	<section class="ed-rail">
		<TemperView spec={refsSpec} />
	</section>

	<p class="t-label">A refused spec</p>
	<section class="ed-rail">
		<TemperView spec={refusedSpec} />
	</section>
</main>

<style>
	.page {
		max-width: 48rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
	h1 {
		margin: 2.5rem 0 2rem;
	}
	.t-label {
		margin: 0 0 0.8rem;
	}
	.ed-rail {
		margin-bottom: 3rem;
	}
	.stack {
		display: grid;
		gap: 0.5rem;
	}
</style>
