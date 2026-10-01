<script lang="ts">
	/**
	 * The view catalog: every component an agent's presented view or a plugin's lens may draw,
	 * each with what the catalog says of it and a specimen rendered through TemperView — the same
	 * gate, so what shows here is what a view gets.
	 */
	import { CATALOG_VERSION } from '$lib/catalog/catalog';
	import { specimens } from '$lib/catalog/specimens';
	import TemperView from '$lib/catalog/TemperView.svelte';
	import type { LensProps } from '../lenses';

	let { tab }: LensProps = $props();

	$effect(() => {
		tab?.setTitle('view catalog');
	});
</script>

<div class="page">
	<header>
		<p class="t-strip">{CATALOG_VERSION} <span aria-hidden="true">·</span> {specimens.length} components</p>
		<h1 class="t-h2">The view catalog</h1>
		<p class="t-body lede">
			What a presented view or a plugin's lens may draw. Each specimen is a spec rendered through
			the catalog's own check.
		</p>
	</header>
	{#each specimens as specimen (specimen.name)}
		<section class="specimen" data-component={specimen.name}>
			<h2 class="t-label">{specimen.name}</h2>
			<p class="description">{specimen.description}</p>
			<div class="render">
				<TemperView spec={specimen.spec} />
			</div>
		</section>
	{/each}
</div>

<style>
	.page {
		max-width: 52rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
		min-width: 0;
	}
	header {
		margin-bottom: 2rem;
	}
	h1 {
		margin: 0.4rem 0 0.6rem;
	}
	.lede {
		margin: 0;
	}
	.specimen {
		padding: 1.4rem 0;
		border-top: 1px solid var(--tp-rule);
		min-width: 0;
	}
	h2 {
		margin: 0 0 0.3rem;
	}
	.description {
		margin: 0 0 1rem;
		font: 0.85rem/1.55 var(--tp-font-reading);
		color: var(--tp-text-subtle);
	}
	.render {
		min-width: 0;
	}
</style>
