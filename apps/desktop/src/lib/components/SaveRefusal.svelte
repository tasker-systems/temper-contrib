<script lang="ts">
	/**
	 * The save refusal, oriented: the document changed since the edit started, nothing was saved,
	 * and here is what the person needs to decide. Who changed the document and when, which
	 * sections differ between the base and the newer version, and the ways forward:
	 *
	 * - **Show changes** — the line-over-line diff, computed by the core, unchanged sections
	 *   collapsed.
	 * - **Take newer** — discard the draft; the room shows the newer version.
	 * - **Keep my draft on the newer base** — the draft stands, now compared against the newer
	 *   hash; the person has seen the newer version and the next save compares against it.
	 * - **Hand to agent** (slice 5) — with a live conversation and a stated intent, the
	 *   disagreement goes to the agent as one prompt (intent + the three versions + the trail
	 *   since the base); its proposal returns as transcript text and is offered here as
	 *   *Apply* — the person's draft on the newer base, reviewed and saved through
	 *   compare-and-save. The proposal never enters the document by itself (ruled,
	 *   temper-artifacts#48). With no agent connected, only the plain choices show.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import type { DocOpened, SectionDiff } from '$lib/document';
	import { ONE_CLICK_WORDS, type Intent } from '$lib/handoff';
	import RegionState from './RegionState.svelte';

	let {
		refused,
		ontakeNewer,
		onkeepDraft,
		intent = $bindable({ freeText: '', oneClick: null }),
		handoffState = 'idle',
		handoffUnavailable = '',
		agentLive = false,
		onhandToAgent,
		onapplyProposal
	}: {
		/** The refusal as the core answered it. */
		refused: {
			current: DocOpened;
			lastBodyChange: { actorName: string; occurredAt: string } | null;
			changedSections: string[];
		};
		ontakeNewer: () => void;
		onkeepDraft: () => void;
		/** The intent, held by the room: the field here edits it in place. */
		intent?: Intent;
		/** Where the handoff stands: idle, sent (the turn in flight), a proposal to review,
		 *  or the turn's no-proposal verdict. */
		handoffState?: 'idle' | 'sent' | 'proposal' | 'none';
		/** Why the hand cannot go, when it cannot: said, never guessed. */
		handoffUnavailable?: string;
		/** Whether a conversation is live — the no-agent arm of ruling Q5. */
		agentLive?: boolean;
		onhandToAgent: () => void;
		onapplyProposal: () => void;
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

	{#if agentLive}
		<div class="handoff" aria-label="Hand this disagreement to the agent">
			<p class="t-strip">or hand the disagreement to the agent — it proposes, you review and save</p>
			<textarea
				class="intent"
				bind:value={intent.freeText}
				placeholder="what you want the agent to do with these versions…"
				rows="3"
				aria-label="Your intent for the agent"
			></textarea>
			<div class="one-click" role="group" aria-label="One-click intents">
				<button
					type="button"
					aria-pressed={intent.oneClick === 'fold'}
					onclick={() => (intent.oneClick = intent.oneClick === 'fold' ? null : 'fold')}
				>
					{ONE_CLICK_WORDS.fold}
				</button>
				<button
					type="button"
					aria-pressed={intent.oneClick === 'keep'}
					onclick={() => (intent.oneClick = intent.oneClick === 'keep' ? null : 'keep')}
				>
					{ONE_CLICK_WORDS.keep}
				</button>
			</div>
			<div class="actions">
				<button
					type="button"
					class="hand"
					onclick={onhandToAgent}
					disabled={handoffState === 'sent'}
				>
					{handoffState === 'sent' ? 'Handed — the agent is working…' : 'Hand to agent'}
				</button>
				{#if handoffState === 'proposal'}
					<button type="button" class="take" onclick={onapplyProposal}>
						Apply the agent's proposal as my draft
					</button>
				{/if}
			</div>
			{#if handoffUnavailable}
				<p class="t-strip refusal-note" role="note">{handoffUnavailable}</p>
			{/if}
			{#if handoffState === 'none'}
				<p class="t-strip refusal-note" role="note">
					The agent did not return a proposal — ask it again in the agent panel, or take newer
					or keep your draft here.
				</p>
			{/if}
		</div>
	{/if}
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
	.actions button:hover:not(:disabled) {
		border-color: var(--tp-accent-line);
		background: var(--tp-accent-wash);
	}
	.actions button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.take {
		border-color: var(--tp-accent-line) !important;
	}
	.handoff {
		display: grid;
		gap: 0.55rem;
		border-top: 1px solid var(--tp-rule);
		padding-top: 0.8rem;
	}
	.intent {
		box-sizing: border-box;
		width: 100%;
		resize: vertical;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		color: var(--tp-text);
		font: 0.85rem var(--tp-font-doing);
	}
	.intent:focus {
		border-color: var(--tp-accent-line);
		outline: none;
	}
	.one-click {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.one-click button {
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		color: var(--tp-text);
		padding: 0.2rem 0.7rem;
		font: inherit;
		font-size: 0.82rem;
		cursor: pointer;
	}
	.one-click button[aria-pressed='true'] {
		border-color: var(--tp-accent-line);
		background: var(--tp-accent-wash);
	}
	.refusal-note {
		margin: 0;
		color: var(--tp-notice);
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