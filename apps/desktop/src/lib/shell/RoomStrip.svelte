<script lang="ts">
	/**
	 * The active step's strip: its way out, what it is, and the lens it is seen through. The way out
	 * walks back along the tab's trail, and at the trail's start returns home — it never points
	 * somewhere that does not resolve, because it is a step the tab holds or the home tab, which
	 * cannot close. Home itself has no way out and no strip.
	 *
	 * The switcher lists every enabled lens that accepts the subject, built or not, each with its
	 * plugin. Choosing one keeps the subject and the trail.
	 */
	import type { Snippet } from 'svelte';
	import { shellContributions } from './contributions';
	import { lensesFor } from './lenses';
	import { HOME_TAB, stepTitle, tabs } from './tabs.svelte';

	/** The room's own actions sit here, never in the masthead. */
	let { actions }: { actions?: Snippet } = $props();

	const tab = $derived(tabs.active);
	const step = $derived(tabs.current(tab));
	const previous = $derived(tab.cursor > 0 ? tab.steps[tab.cursor - 1] : null);
	const next = $derived(tab.cursor < tab.steps.length - 1 ? tab.steps[tab.cursor + 1] : null);
	const options = $derived(lensesFor(step.subject, step.docType, shellContributions.enabled));
</script>

{#if tab.id !== HOME_TAB}
	<nav class="room-strip" aria-label="This room">
		{#if previous}
			<button class="t-way-out" title={`Back to ${stepTitle(previous)}`} onclick={() => tabs.back()}>
				<span class="arrow" aria-hidden="true">←</span>
				<span class="to">{stepTitle(previous)}</span>
			</button>
		{:else}
			<button class="t-way-out" onclick={() => tabs.activate(HOME_TAB)}>
				<span class="arrow" aria-hidden="true">←</span> home
			</button>
		{/if}
		{#if next}
			<button
				class="forward"
				aria-label={`Forward to ${stepTitle(next)}`}
				title={`Forward to ${stepTitle(next)}`}
				onclick={() => tabs.forward()}>→</button
			>
		{/if}
		<span class="t-room-title">{stepTitle(step)}</span>
		{#if options.length}
			<span class="t-strip">through the lens of</span>
			<span class="lenses" role="group" aria-label="Lenses">
				{#each options as lens (lens.id)}
					<button
						class="lens"
						aria-pressed={step.lens === lens.id}
						onclick={() => tabs.setLens(tab.id, lens.id)}
					>
						{lens.name}
						<span class="plugin">· {lens.plugin}{lens.build.state === 'unbuilt' ? ' — not built yet' : ''}</span>
					</button>
				{/each}
			</span>
		{/if}
		<span class="spacer"></span>
		{#if actions}{@render actions()}{/if}
	</nav>
{/if}

<style>
	.room-strip {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem 0.9rem;
		padding: 0.55rem 1.2rem;
		border-bottom: 1px solid var(--tp-rule);
	}
	button {
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
	}
	.t-way-out {
		display: inline-flex;
		gap: 0.35rem;
		max-width: 16rem;
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text);
	}
	.t-way-out:hover {
		color: var(--tp-accent);
	}
	.to {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.forward {
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	.forward:hover {
		color: var(--tp-text);
	}
	.t-room-title {
		max-width: 20rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: italic 0.88rem var(--tp-font-reading);
		color: var(--tp-text-muted);
	}
	.lenses {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.lens {
		padding: 0.15rem 0.5rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-chip);
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text-muted);
		transition: border-color var(--tp-motion-quick) var(--tp-motion-easing);
	}
	.lens:hover {
		border-color: var(--tp-accent-line-soft);
	}
	.lens[aria-pressed='true'] {
		border-color: var(--tp-accent-line);
		background: var(--tp-accent-wash);
		color: var(--tp-text);
	}
	.plugin {
		color: var(--tp-text-subtle);
	}
	.spacer {
		flex: 1;
	}
</style>
