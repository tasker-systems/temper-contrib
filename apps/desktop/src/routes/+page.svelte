<script lang="ts">
	// The conversation lives in the agent panel, owned by the engagement store
	// ($lib/agent/session.svelte) and surviving every room change. This page is
	// home until the home build lands.
	import TemperViews from '$lib/components/TemperViews.svelte';
</script>

<main class="page">
	<p class="t-label">ACP chat</p>
	<p class="t-strip">
		The conversation now lives in the agent panel — <span aria-hidden="true">→</span> it keeps
		running while you open rooms, and a closed panel still shows its pending count on the
		<span class="strip-em">agent</span> toggle.
	</p>

	<TemperViews />
</main>

<style>
	.page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2.5rem 1.5rem 4rem;
	}
	.t-label {
		margin: 0 0 0.8rem;
	}
	.strip-em {
		color: var(--tp-text);
	}
</style>