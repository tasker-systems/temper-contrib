<script lang="ts">
	// Fonts are bundled, never fetched: the desktop must render offline.
	import '@fontsource-variable/source-serif-4';
	import '@fontsource-variable/source-serif-4/wght-italic.css';
	import '@fontsource-variable/jetbrains-mono';
	import '@fontsource-variable/inter';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import Shell from '$lib/shell/Shell.svelte';
	import { temperViews } from '$lib/temper-views.svelte';
	import { themeStore } from '$lib/theme-store.svelte';

	// The shell is the whole window. SvelteKit's router is not how anyone moves between rooms —
	// the tab model is — so the one page under this layout renders nothing of its own.
	themeStore.init();
	temperViews.init();

	$effect(() => {
		document.documentElement.dataset.theme = themeStore.active;
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<Shell />
