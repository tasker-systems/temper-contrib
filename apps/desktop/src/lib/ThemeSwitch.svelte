<script lang="ts">
	/**
	 * Applies the person's theme preference to <html data-theme>, following the system's
	 * appearance when asked to. The control is text actions, as every temper action is.
	 */
	import { onMount } from 'svelte';
	import { DEFAULT_PREFERENCE, THEMES, loadPreference, resolveTheme, savePreference, type ThemePreference } from './theme';

	let pref = $state<ThemePreference>(DEFAULT_PREFERENCE);
	let systemDark = $state(true);
	const active = $derived(resolveTheme(pref, systemDark));

	onMount(() => {
		pref = loadPreference(globalThis.localStorage);
		const query = matchMedia('(prefers-color-scheme: dark)');
		systemDark = query.matches;
		const onChange = (e: MediaQueryListEvent) => (systemDark = e.matches);
		query.addEventListener('change', onChange);
		return () => query.removeEventListener('change', onChange);
	});

	$effect(() => {
		document.documentElement.dataset.theme = active;
	});

	function choose(next: ThemePreference) {
		pref = next;
		savePreference(globalThis.localStorage, next);
	}
</script>

<div class="switch" role="group" aria-label="Theme">
	<button
		class="t-action"
		aria-pressed={pref.follow === 'system'}
		onclick={() => choose({ follow: 'system', family: active })}>Follow system</button
	>
	{#each THEMES as theme (theme.name)}
		<button
			class="t-action"
			aria-pressed={pref.follow === 'fixed' && pref.name === theme.name}
			onclick={() => choose({ follow: 'fixed', name: theme.name })}>{theme.title}</button
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
