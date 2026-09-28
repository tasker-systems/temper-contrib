<script lang="ts">
	/**
	 * Core's home: the throughline of the work. Home is the frame — the heading, the line, the
	 * order — and every section in it is a lens pinned to home (ruling A), contributed by core or
	 * a plugin. Sections read once per show: the frame counts each time home is shown, and hands
	 * the count to every section, which reads when it changes and never on hover.
	 *
	 * A section that is named and not built says so, and what lands it — never an empty state
	 * claiming there is nothing, when nothing has been read.
	 */
	import { untrack } from 'svelte';
	import { enabled } from '../contributions';
	import { homeSections, type LensDecl, type LensProps } from '../lenses';
	import { HOME_TAB, tabs } from '../tabs.svelte';

	let { subject, tab }: LensProps = $props();

	const sections = homeSections(enabled);

	let shown = $state(0);
	$effect(() => {
		if (tabs.activeId === HOME_TAB) untrack(() => (shown += 1));
	});

	const loaders = new Map(
		sections
			.map(({ lens }) => lens)
			.filter((lens): lens is LensDecl & { build: { state: 'built' } } => lens.build.state === 'built')
			.map((lens) => [lens.id, lens.build.component()])
	);
</script>

<div class="home">
	<header class="masthead">
		<p class="t-label">home · the throughline</p>
		<h1 class="t-hero-title">Where the <em>work</em> stands</h1>
		<p class="t-tagline">Pick up where you were, answer what waits on you, start something, or go looking.</p>
	</header>

	{#each sections as { lens, heading } (lens.id)}
		<section class="section" aria-label={lens.name} data-section={lens.id}>
			{#if heading}
				<h2 class="t-label heading">{heading}</h2>
			{/if}
			{#if lens.build.state === 'unbuilt'}
				<p class="unbuilt">
					The <span class="name">{lens.name}</span> section isn't built yet — it lands with
					{lens.build.landsWith}.
				</p>
			{:else}
				{#await loaders.get(lens.id) then mod}
					{#if mod}
						<mod.default {subject} {tab} {shown} />
					{/if}
				{:catch err}
					<p class="unbuilt">The {lens.name} section failed to load: {String(err)}</p>
				{/await}
			{/if}
		</section>
	{/each}
</div>

<style>
	.home {
		display: grid;
		gap: 1.1rem;
		max-width: 46rem;
		margin: 0 auto;
		padding: 2.5rem 1.5rem 4rem;
	}
	.masthead {
		display: grid;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}
	.masthead > * {
		margin: 0;
	}
	.section {
		display: grid;
		gap: 0.5rem;
	}
	.heading {
		margin: 0.9rem 0 0;
		color: var(--tp-accent);
	}
	.unbuilt {
		margin: 0;
		padding: 0.7rem 0.9rem;
		border: 1px dashed var(--tp-rule-strong);
		border-radius: var(--tp-radius-panel);
		font: 0.85rem var(--tp-font-ui);
		color: var(--tp-text-subtle);
	}
	.name {
		color: var(--tp-text-muted);
	}
</style>
