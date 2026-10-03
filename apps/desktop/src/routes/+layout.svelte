<script lang="ts">
	// Fonts are bundled, never fetched: the desktop must render offline.
	import '@fontsource-variable/source-serif-4';
	import '@fontsource-variable/source-serif-4/wght-italic.css';
	import '@fontsource-variable/jetbrains-mono';
	import '@fontsource-variable/inter';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import type { Snippet } from 'svelte';
	import { initHubWriter } from '$lib/shell/hub-writer';
	import { shellContributions } from '$lib/shell/contributions';
	import Shell from '$lib/shell/Shell.svelte';
	import { temperViews } from '$lib/temper-views.svelte';
	import { themeStore } from '$lib/theme-store.svelte';

	// The shell is the whole window. SvelteKit's router is not how anyone moves between rooms —
	// the tab model is — so the one page under this layout renders nothing of its own. The page
	// is still rendered below, where it can never show: it is empty by design (routes/+page.svelte),
	// and an address the router does not know still gets the shell rather than an error body.
	let { children }: { children?: Snippet } = $props();

	themeStore.init();
	temperViews.init();
	initHubWriter();
	// The packages the desktop ships beside itself are read before the shell renders, so home's
	// sections and the ways-in panel are seen whole at first sight; a scan that cannot answer
	// leaves core standing alone.
	void shellContributions.settled();

	$effect(() => {
		document.documentElement.dataset.theme = themeStore.active;
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if shellContributions.ready}
	<Shell />
{/if}
{@render children?.()}
