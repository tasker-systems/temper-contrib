<script lang="ts">
	/**
	 * The open tabs: home pinned first, then each tab named by its subject and the lens it is seen
	 * through. Bounded, and it says so: the count sits at the strip's end, a tab set aside to make
	 * room is listed there to reopen, and what a move did or refused is said beneath the strip.
	 */
	import { enabled } from './contributions';
	import { lensById } from './lenses';
	import { HOME_TAB, stepTitle, TAB_BOUND, tabs } from './tabs.svelte';

	const lensName = (id: string | null) => (id ? (lensById(id, enabled)?.name ?? id) : '');

	let asideOpen = $state(false);
	let asideRoot: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!asideOpen) return;
		const away = (event: PointerEvent) => {
			if (asideRoot && !asideRoot.contains(event.target as Node)) asideOpen = false;
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') asideOpen = false;
		};
		document.addEventListener('pointerdown', away);
		document.addEventListener('keydown', escape);
		return () => {
			document.removeEventListener('pointerdown', away);
			document.removeEventListener('keydown', escape);
		};
	});
</script>

<div class="strip">
	<div class="tabs" role="tablist" aria-label="Open tabs">
		{#each tabs.tabs as tab (tab.id)}
			{@const step = tabs.current(tab)}
			<div class="tab" class:active={tab.id === tabs.activeId}>
				<button
					role="tab"
					class="pick"
					aria-selected={tab.id === tabs.activeId}
					title={`${stepTitle(step)} · ${lensName(step.lens)}`}
					onclick={() => tabs.activate(tab.id)}
				>
					<span class="title">{stepTitle(step)}</span>
					<span class="lens">{lensName(step.lens)}</span>
				</button>
				{#if tab.id !== HOME_TAB}
					<button
						class="close"
						aria-label={`Close ${stepTitle(step)}`}
						onclick={() => tabs.close(tab.id)}>×</button
					>
				{/if}
			</div>
		{/each}
	</div>
	<span class="count">{tabs.openCount} open · {TAB_BOUND} at most</span>
	{#if tabs.setAside.length}
		<div class="aside" bind:this={asideRoot}>
			<button
				class="aside-toggle"
				aria-expanded={asideOpen}
				onclick={() => (asideOpen = !asideOpen)}
			>
				set aside · {tabs.setAside.length}
			</button>
			{#if asideOpen}
				<ul class="aside-list" aria-label="Tabs set aside">
					{#each tabs.setAside as tab (tab.id)}
						{@const step = tabs.current(tab)}
						<li>
							<button
								onclick={() => {
									asideOpen = false;
									tabs.reopen(tab.id);
								}}
							>
								<span class="title">{stepTitle(step)}</span>
								<span class="lens">{lensName(step.lens)} · {tab.steps.length} on its trail</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
{#if tabs.notice}
	<p class="notice" role="status">{tabs.notice}</p>
{/if}

<style>
	.strip {
		display: flex;
		align-items: stretch;
		height: 2.5rem;
		border-bottom: 1px solid var(--tp-rule);
		background: var(--tp-surface);
	}
	.tabs {
		display: flex;
		min-width: 0;
	}
	.tab {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
		max-width: 14rem;
		padding: 0 0.8rem;
		border-right: 1px solid var(--tp-rule);
		border-bottom: 2px solid transparent;
	}
	.tab.active {
		background: var(--tp-ground);
		border-bottom-color: var(--tp-accent-line);
	}
	.pick {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
		padding: 0;
		border: 0;
		background: none;
		text-align: left;
		cursor: pointer;
	}
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 0.8rem var(--tp-font-ui);
		color: var(--tp-text-muted);
	}
	.active .title {
		color: var(--tp-text);
	}
	.lens {
		font: 0.58rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-strip);
		text-transform: uppercase;
		color: var(--tp-text-subtle);
	}
	.close {
		padding: 0 0.15rem;
		border: 0;
		background: none;
		font: 0.75rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
		cursor: pointer;
	}
	.close:hover {
		color: var(--tp-text);
	}
	.count {
		flex: none;
		align-self: center;
		margin-left: auto;
		padding: 0 1rem;
		font: 0.6rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-strip);
		color: var(--tp-text-subtle);
	}
	.aside {
		position: relative;
		align-self: center;
		padding-right: 1rem;
	}
	.aside-toggle {
		padding: 0;
		border: 0;
		background: none;
		font: 0.6rem var(--tp-font-doing);
		letter-spacing: var(--tp-tracking-strip);
		color: var(--tp-accent);
		cursor: pointer;
	}
	.aside-toggle:hover {
		color: var(--tp-text);
	}
	.aside-list {
		position: absolute;
		top: calc(100% + 0.5rem);
		right: 0.5rem;
		z-index: 10;
		display: grid;
		gap: 0.1rem;
		width: 18rem;
		margin: 0;
		padding: 0.35rem;
		list-style: none;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface-raised);
	}
	.aside-list button {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		width: 100%;
		padding: 0.35rem 0.5rem;
		border: 0;
		border-radius: var(--tp-radius-chip);
		background: none;
		text-align: left;
		cursor: pointer;
	}
	.aside-list button:hover {
		background: var(--tp-accent-wash);
	}
	.notice {
		margin: 0;
		padding: 0.45rem 1rem;
		border-bottom: 1px solid var(--tp-rule);
		background: var(--tp-notice-wash);
		font: italic 0.82rem var(--tp-font-reading);
		color: var(--tp-notice);
	}
</style>
