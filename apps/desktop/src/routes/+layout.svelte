<script lang="ts">
	// Fonts are bundled, never fetched: the desktop must render offline.
	import '@fontsource-variable/source-serif-4';
	import '@fontsource-variable/source-serif-4/wght-italic.css';
	import '@fontsource-variable/jetbrains-mono';
	import '@fontsource-variable/inter';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import ThemeSwitch from '$lib/ThemeSwitch.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<header class="masthead">
	<svg viewBox="0 0 32 32" aria-hidden="true">
		<path d="M 12 7 L 12 25" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none" />
		<path d="M 6 13 L 18 13 Q 23 13 25 16.5 Q 27 20 25 24" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" fill="none" />
	</svg>
	<a class="t-wordmark" href="/">temper</a>
	<nav class="t-strip"><a href="/">home</a><span aria-hidden="true">·</span><a href="/catalog">catalog</a></nav>
	<span class="spacer"></span>
	<ThemeSwitch />
</header>

{@render children()}

<style>
	.masthead {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		padding: 0.9rem 1.5rem;
		border-bottom: 1px solid var(--tp-rule);
		color: var(--tp-accent);
	}
	.masthead svg {
		width: 20px;
		height: 20px;
	}
	.masthead a {
		text-decoration: none;
	}
	nav {
		display: flex;
		gap: 0.5rem;
	}
	nav a {
		color: inherit;
	}
	nav a:hover {
		color: var(--tp-text);
	}
	.spacer {
		flex: 1;
	}
</style>
