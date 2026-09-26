<script lang="ts">
	/**
	 * The one way a spec reaches the screen: checked against the `temper` catalog first. A spec
	 * that fails renders its refusal — what was refused and why — never a partial render, and
	 * never the raw renderer's silent drop of what it could not draw.
	 */
	import { JsonUIProvider, Renderer, type ActionHandler } from '@json-render/svelte';
	import { checkSpec, CATALOG_VERSION } from './catalog';
	import { temperRegistry } from './registry';

	let { spec, handlers = {} }: { spec: unknown; handlers?: Record<string, ActionHandler> } = $props();

	const checked = $derived(checkSpec(spec));
</script>

{#if checked.ok}
	<JsonUIProvider {handlers}>
		<Renderer spec={checked.spec} registry={temperRegistry} />
	</JsonUIProvider>
{:else}
	<div class="refused" role="alert">
		<p class="head"><span aria-hidden="true">!</span> This view was refused — it does not satisfy {CATALOG_VERSION}.</p>
		<ul>
			{#each checked.errors as error (error)}
				<li>{error}</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.refused {
		border-left: 2px solid var(--tp-region-failed);
		background: var(--tp-region-failed-wash);
		color: var(--tp-region-failed);
		padding: 0.6rem 0.9rem;
		border-radius: 0 5px 5px 0;
	}
	.head {
		margin: 0 0 0.3rem;
		font-weight: 600;
		font-size: 0.8rem;
	}
	ul {
		margin: 0;
		padding-left: 1.1rem;
		font: 0.72rem/1.6 var(--tp-font-doing);
	}
</style>
