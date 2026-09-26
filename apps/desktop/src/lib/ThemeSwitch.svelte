<script lang="ts">
	/**
	 * The Appearance control: text actions, as every temper action is. Edits the shared theme
	 * store, which the layout applies to the document; the choice itself is held by the core's
	 * settings store.
	 */
	import { onMount } from 'svelte';
	import { THEMES } from './theme';
	import { themeStore } from './theme-store.svelte';

	onMount(() => themeStore.init());
</script>

<div class="switch" role="group" aria-label="Theme">
	<button
		class="t-action"
		aria-pressed={themeStore.pref.follow === 'system'}
		onclick={() => themeStore.choose({ follow: 'system', family: themeStore.active })}>Follow system</button
	>
	{#each THEMES as theme (theme.name)}
		<button
			class="t-action"
			aria-pressed={themeStore.pref.follow === 'fixed' && themeStore.pref.name === theme.name}
			onclick={() => themeStore.choose({ follow: 'fixed', name: theme.name })}>{theme.title}</button
		>
	{/each}
</div>

<style>
	.switch {
		display: flex;
		gap: 1rem;
	}
	.switch :global(button[aria-pressed='true']) {
		color: var(--tp-text);
	}
</style>
