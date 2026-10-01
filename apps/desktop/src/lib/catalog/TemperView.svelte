<script lang="ts">
	/**
	 * The one way a spec reaches the screen: checked against the `temper` catalog first. A spec
	 * that fails renders its refusal — what was refused and why — never a partial render, and
	 * never the raw renderer's silent drop of what it could not draw.
	 *
	 * `actions` are the host's handlers for the view actions components declare (`view-actions.ts`):
	 * the only way a rendered view asks anything of its host.
	 */
	import { JsonUIProvider, Renderer } from '@json-render/svelte';
	import { untrack } from 'svelte';
	import { checkSpec, CATALOG_VERSION } from './catalog';
	import { temperRegistry } from './registry';
	import {
		setViewActions,
		undeclaredActions,
		type ViewActionHandlers,
		viewActions
	} from './view-actions';

	let { spec, actions = {} }: { spec: unknown; actions?: ViewActionHandlers } = $props();

	const undeclared = untrack(() => undeclaredActions(actions));
	if (undeclared.length)
		throw new Error(`handlers for actions the catalog does not declare: ${undeclared.join(', ')}`);
	setViewActions(viewActions(() => actions));

	const checked = $derived(checkSpec(spec));
</script>

{#if checked.ok}
	<JsonUIProvider>
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
