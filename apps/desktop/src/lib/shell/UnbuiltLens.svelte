<script lang="ts">
	/**
	 * A lens that is named and not built yet. The tab still holds its subject; this says what the
	 * lens is, what lands it, and which built lenses can show the subject now. No skeleton, no
	 * empty grid — a guess at what the lens would show would overstate itself.
	 */
	import type { LensDecl } from './lenses';

	let {
		lens,
		holds,
		alternatives,
		onchoose
	}: {
		lens: LensDecl & { build: { state: 'unbuilt' } };
		/** What the tab holds, in words. */
		holds: string;
		/** The built lenses that accept this subject. */
		alternatives: LensDecl[];
		onchoose: (lensId: string) => void;
	} = $props();
</script>

<div class="page" role="status">
	<p class="t-label">{lens.name} · {lens.plugin}</p>
	<p class="words">
		The {lens.name} lens isn’t built yet — it lands with {lens.build.landsWith}. This tab still
		holds <em>{holds}</em>.
	</p>
	{#if alternatives.length}
		<p class="t-strip">
			built for this now:
			{#each alternatives as alt, i (alt.id)}
				{#if i > 0}<span aria-hidden="true"> · </span>{/if}
				<button class="t-action" onclick={() => onchoose(alt.id)}>{alt.name} · {alt.plugin}</button>
			{/each}
		</p>
	{:else}
		<p class="t-strip">no built lens shows this yet</p>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: 0.8rem;
		max-width: 44rem;
		margin: 0 auto;
		padding: 2.5rem 1.5rem 4rem;
	}
	.t-label,
	.t-strip {
		margin: 0;
	}
	.words {
		margin: 0;
		font: 1.05rem/1.7 var(--tp-font-reading);
		color: var(--tp-text-muted);
	}
	.words em {
		color: var(--tp-text);
	}
	.t-action {
		padding: 0;
	}
</style>
