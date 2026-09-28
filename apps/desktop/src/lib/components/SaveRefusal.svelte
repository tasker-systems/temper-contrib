<script lang="ts">
	/**
	 * The save refusal, oriented: the document changed since the edit started, nothing was saved,
	 * and here is what the person needs to decide. Who changed the document and when, which
	 * sections differ between the base and the newer version, and three ways forward:
	 *
	 * - **Show changes** — the line-over-line diff, computed by the core, unchanged sections
	 *   collapsed.
	 * - **Take newer** — discard the draft; the room shows the newer version.
	 * - **Keep my draft on the newer base** — the draft stands, now compared against the newer
	 *   hash; the person has seen the newer version and the next save compares against it.
	 *
	 * Handing the disagreement to the agent is slice 5; this slice makes the room safe without it.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import type { DocOpened, SectionDiff } from '$lib/document';
	import RegionState from './RegionState.svelte';

	let {
		refused,
		ontakeNewer,
		onkeepDraft
	}: {
		/** The refusal as the core answered it. */
		refused: {
			current: DocOpened;
			lastBodyChange: { actorName: string; occurredAt: string } | null;
			changedSections: string[];
		};
		ontakeNewer: () => void;
		onkeepDraft: () => void;
	} = $props();

	let showing = $state(false);
	let diff = $state<SectionDiff | null>(null);
	let diffState = $state<'idle' | 'arriving' | 'failed'>('idle');
	let diffMessage = $state('');

	const current = $derived(refused.current.state === 'opened' ? refused.current : null);
	const changedBy = $derived(
		refused.lastBodyChange
			? `${refused.lastBodyChange.actorName}, ${new Date(refused.lastBodyChange.occurredAt).toLocaleString()}`
			: 'unknown — the history could not be read'
	);

	async function showChanges(): Promise<void> {
		if (diff) {
			showing = false;
			return;
		}
		const base = refused.current.state === 'opened' ? refused.current.markdown : '';
		diffState = 'arriving';
		try {
			diff = await invoke<SectionDiff>('doc_show_changes', { from: base, to: current?.markdown });
			diffState = 'idle';
			showing = true;
		} catch (err) {
			diffMessage = String(err);
			diffState = 'failed';
		}
	}
</script>

<section class="refusal">
	<h2 class="t-h3">This document changed since you opened it — nothing was saved</h2>
	<p class="who">
		Last changed by <strong>{changedBy}</strong>
		{#if refused.changedSections.length}
			— sections that differ: {refused.changedSections.join(', ')}
		{/if}
	</p>
	<div class="actions">
		<button type="button" onclick={showChanges}>
			{showing ? 'Hide changes' : 'Show changes'}
		</button>
		<button type="button" class="take" onclick={ontakeNewer}>Take newer</button>
		<button type="button" class="keep" onclick={onkeepDraft}>Keep my draft on the newer base</button>
	</div>
	{#if diffState === 'arriving'}
		<RegionState state="arriving" label="the changes" />
	{:else if diffState === 'failed'}
		<RegionState state="failed" label="the changes" detail={diffMessage} />
	{:else if showing && diff}
		<div class="diff">
			{#each diff.sections as section}
				<div class="section">
					{#if section.heading}
						<h3 class="heading">{section.heading}</h3>
					{/if}
					{#if section.state === 'unchanged'}
						<p class="collapsed">
							unchanged — {section.lineCount}
							{section.lineCount === 1 ? 'line' : 'lines'}
						</p>
					{:else}
						{#each section.lines as line}
							<pre class="line {line.tag}"><code>{line.segments
										.map((s: { emphasized: boolean; text: string }) =>
											s.emphasized ? `\u200b${s.text}` : s.text
										)
										.join('')}</code></pre>
						{/each}
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	.refusal {
		border: 1px solid var(--tp-notice);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-notice-wash);
		padding: 1rem 1.2rem;
		display: grid;
		gap: 0.8rem;
	}
	h2 {
		margin: 0;
		color: var(--tp-notice);
	}
	.who {
		margin: 0;
		color: var(--tp-text);
	}
	.actions {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.actions button {
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		color: var(--tp-text);
		padding: 0.25rem 0.8rem;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.actions button:hover {
		border-color: var(--tp-accent-line);
		background: var(--tp-accent-wash);
	}
	.take {
		border-color: var(--tp-accent-line) !important;
	}
	.diff {
		display: grid;
		gap: 0.4rem;
	}
	.section {
		display: grid;
		gap: 0.15rem;
	}
	.heading {
		margin: 0.4rem 0 0;
		font-size: 0.9rem;
		color: var(--tp-text-subtle);
	}
	.collapsed {
		margin: 0;
		color: var(--tp-text-faint);
		font-size: 0.85rem;
	}
	.line {
		margin: 0;
		padding: 0 0.4rem;
		border-radius: 0.2rem;
		font-family: var(--tp-font-doing);
		font-size: 0.82rem;
		white-space: pre-wrap;
	}
	.line.equal {
		color: var(--tp-text-subtle);
	}
	.line.delete {
		background: var(--tp-danger-wash);
		color: var(--tp-danger);
	}
	.line.insert {
		background: var(--tp-success-wash);
		color: var(--tp-success);
	}
</style>