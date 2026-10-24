<script lang="ts">
	/**
	 * A tab's body: the step at its cursor. A step change re-keys the host, so one room lives per
	 * step and going back re-reads the room it returns to; switching lens keeps the step, so it
	 * re-reads nothing.
	 */
	import StepHost from './StepHost.svelte';
	import type { Tab } from './tabs.svelte';

	let { tab }: { tab: Tab } = $props();
	const step = $derived.by(() => {
		const at = tab.steps[tab.cursor];
		if (at === undefined) throw new Error(`tab ${tab.id} has no step at its cursor`);
		return at;
	});
</script>

{#key step.key}
	<StepHost tabId={tab.id} {step} />
{/key}
