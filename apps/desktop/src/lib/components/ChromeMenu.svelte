<script lang="ts">
	/**
	 * The chrome's standing menu, at the masthead's left: what the building offers
	 * from any room. Bounded — "app setup" is its only entry today. It opens only
	 * when the person opens it; nothing on the app's behalf opens it, and nothing
	 * navigates to a setup room unprompted.
	 */
	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();

	function onDocumentPointerDown(event: PointerEvent): void {
		if (root && !root.contains(event.target as Node)) open = false;
	}

	function onDocumentKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') open = false;
	}

	$effect(() => {
		document.addEventListener('pointerdown', onDocumentPointerDown);
		document.addEventListener('keydown', onDocumentKeydown);
		return () => {
			document.removeEventListener('pointerdown', onDocumentPointerDown);
			document.removeEventListener('keydown', onDocumentKeydown);
		};
	});
</script>

<div class="chrome-menu" bind:this={root}>
	<button
		type="button"
		class="trigger"
		aria-haspopup="menu"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<span class="glyph" aria-hidden="true">≡</span>menu
	</button>
	{#if open}
		<ul class="entries" role="menu">
			<li role="none">
				<a role="menuitem" href="/setup" onclick={() => (open = false)}>app setup…</a>
			</li>
		</ul>
	{/if}
</div>

<style>
	.chrome-menu {
		position: relative;
	}
	.trigger {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.2rem 0.55rem;
		border: 1px solid transparent;
		border-radius: var(--tp-radius-chip);
		background: none;
		color: var(--tp-text);
		font: 0.8rem var(--tp-font-doing);
		cursor: pointer;
	}
	.trigger:hover,
	.trigger[aria-expanded='true'] {
		border-color: var(--tp-rule-strong);
	}
	.glyph {
		font-size: 1rem;
		line-height: 1;
		color: var(--tp-accent);
	}
	.entries {
		position: absolute;
		top: calc(100% + 0.35rem);
		left: 0;
		z-index: 10;
		min-width: 9rem;
		margin: 0;
		padding: 0.3rem;
		list-style: none;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface-raised);
	}
	.entries a {
		display: block;
		padding: 0.35rem 0.55rem;
		border-radius: var(--tp-radius-chip);
		color: var(--tp-text);
		font: 0.8rem var(--tp-font-doing);
		text-decoration: none;
	}
	.entries a:hover {
		background: var(--tp-surface-raised);
		color: var(--tp-accent);
	}
</style>
