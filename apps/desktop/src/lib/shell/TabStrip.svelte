<script lang="ts">
	/**
	 * The open tabs: home pinned first, then each tab named by its subject and the lens it is seen
	 * through. Bounded, and it says so: the count sits at the strip's end, and a move the model
	 * refused says why beneath it.
	 */
	import { enabled } from './contributions';
	import { lensById } from './lenses';
	import { HOME_TAB, stepTitle, TAB_BOUND, tabs } from './tabs.svelte';

	const lensName = (id: string | null) => (id ? (lensById(id, enabled)?.name ?? id) : '');
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
	.notice {
		margin: 0;
		padding: 0.45rem 1rem;
		border-bottom: 1px solid var(--tp-rule);
		background: var(--tp-notice-wash);
		font: italic 0.82rem var(--tp-font-reading);
		color: var(--tp-notice);
	}
</style>
