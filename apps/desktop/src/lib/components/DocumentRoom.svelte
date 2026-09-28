<script lang="ts">
	/**
	 * The document room: body first. The properties strip sits above the rendered body and nothing
	 * sits beside it; what the document is connected to, and how it came to be, is in the about
	 * panel, read on request.
	 *
	 * The room does not read its own body: the tab that hosts it reads the body and its hash once,
	 * on opening, to learn which lens to show it through, and hands the answer here. Every other
	 * read is the panel's, and each renders its own state, so a failed read elsewhere never blanks
	 * the body. Once the answer names the document, the room names its tab.
	 *
	 * Editing (slice 3): Edit opens the editor over the composed markdown. The draft saves
	 * through `doc_save_body`, guarded by the hash the room recorded at open — a save against a
	 * moved base never lands, and its refusal orients the person (SaveRefusal) instead of
	 * overwriting or merging. A byte-identical save is prevented client-side: the Save button is
	 * disabled while the text equals the base, so no ledger churn is invited. While a draft is
	 * dirty the room holds the tab — beforeLeave answers with the draft's sentence — and the
	 * save's outcome replaces the base in place: the room re-renders from the saved answer, and
	 * any open panel tab refreshes against the same resource on its next read.
	 *
	 * Metadata (slice 3b): the properties strip offers its edit controls and saves through
	 * `doc_save_meta` — a separate channel from the body's. The patch carries only what the
	 * person changed (title, changed descriptions, removed keys as nulls), never the body, so
	 * neither save can overwrite the other. A landed metadata save re-reads in place, and the
	 * open panel tabs refresh against the same resource.
	 *
	 * Return (slice 4): where the person was in the body is a device fact, kept beside the other
	 * device stores and never in temper (ruling Q2). Opening restores the saved position when
	 * this device holds one and the heading it names still exists — the anchor plus the fraction
	 * through its section. A heading the saved position names that the body no longer holds is
	 * said, and the room starts at the top: the sentence is a verdict, not an alarm.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { mergeProperties } from '$lib/properties';
	import { agentSession } from '$lib/agent/session.svelte';
	import type { BodySaved, DocOpened, History, MetaSaved, PanelRead } from '$lib/document';
	import {
		handoffPrompt,
		intentStated,
		proposalFrom,
		trailSince,
		type Intent
	} from '$lib/handoff';
	import {
		anchorExists,
		capture,
		headingOccurrences,
		readPosition,
		restoreTop,
		savePosition
	} from '$lib/scroll-position';
	import type { TabHandle } from '$lib/shell/lenses';
	import { ageWords } from '$lib/temper-views.svelte';
	import AboutPanel from './AboutPanel.svelte';
	import DocumentEditor from './DocumentEditor.svelte';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import PropertySet from './PropertySet.svelte';
	import RegionState from './RegionState.svelte';
	import SaveRefusal from './SaveRefusal.svelte';

	let {
		id,
		opened,
		tab
	}: {
		/** The reference the tab opened, whatever the read answered. */
		id: string;
		/** The host's open answer; absent while it is arriving. */
		opened?: DocOpened;
		tab?: TabHandle;
	} = $props();

	$effect(() => {
		if (opened?.state === 'opened') tab?.setTitle(opened.title);
	});

	const doc = $derived(opened?.state === 'opened' ? opened : null);
	const rows = $derived(doc ? mergeProperties(doc.managedMeta, doc.openMeta, doc.docType) : []);

	let editing = $state(false);
	let draft = $state('');
	let saving = $state(false);
	let saveFailed = $state('');
	let refusal = $state<Extract<BodySaved, { state: 'refused' }> | null>(null);

	// ─── Intent handoff (slice 5) ───────────────────────────────────────────────────────────
	//
	// The refusal's intent field and its send. The material is composed at hand time from the
	// state the refusal stands on; the trail is read then, once, and never re-read. The reply
	// path is the conversation turn that follows the prompt (ruled, temper-artifacts#48): the
	// turn's last ```proposal fence is the proposal, taken only when the person applies it.

	/** The intent as the person has stated it so far, in the refusal's field. */
	let intent = $state<Intent>({ freeText: '', oneClick: null });
	/** The handoff's state: idle, the turn in flight (the transcript carries it), or the
	 *  turn's outcome — a proposal awaiting the person's review, or the no-proposal verdict. */
	let handoffState = $state<
		| { phase: 'idle' }
		| { phase: 'sent' }
		| { phase: 'proposal'; proposal: string }
		| { phase: 'none' }
	>({ phase: 'idle' });
	/** Why "Hand to agent" is unavailable, when it is. */
	let handoffUnavailable = $state('');

	/** The base the draft is measured against: the opened hash until a keep-on-newer re-bases it. */
	let baseHash = $state('');
	let baseMarkdown = $state('');
	/** What the editor seeds its document with: captured at startEdit, and at a keep-on-newer
	 * re-base (the draft, re-seeded on the newer base). Read once by the editor's mount effect —
	 * never a live expression, or every keystroke would re-create the editor. */
	let seed = $state('');
	const dirty = $derived(doc !== null && editing && draft !== doc.markdown);

	// The draft guard: while a draft is dirty the tab is asked before it leaves its step, and
	// the core is told — a window close is prevented by the core and announced back
	// (doc-close-requested), so the draft asks before it is lost.
	$effect(() => {
		if (!tab || !dirty) return;
		const release = tab.beforeLeave(() =>
			'This document has an unsaved draft — leave anyway? The draft is kept until you close the tab.'
		);
		return release;
	});

	// The room knows its drafts; the core only answers whether one stands. Reported on
	// transitions only — the core's flag starts false, so a mount and a clean room are
	// never reports, and a landed save's return to false clears it.
	let reportedDirty = $state(false);
	$effect(() => {
		if (dirty === reportedDirty) return;
		reportedDirty = dirty;
		invoke('doc_draft_state', { dirty }).catch(() => {});
	});

	// ─── Return (slice 4): the device-local position ────────────────────────────────────────
	//
	// The scroll box is the body's own scroll container — the tab's `.tab-body` in the shell,
	// the room's nearest scrollable ancestor in a test. Found once, read on mount and scroll.

	/** The rendered body, for heading reads. */
	let bodyEl: HTMLElement | null = $state(null);

	/** What the restore did, for the room to say: the saved position applied, or why not. */
	let positionNote = $state<string | null>(null);
	/** The restored position's anchor, until the person scrolls away from it — then cleared. */
	let positionAnchor = $state<string | null>(null);

	function scrollBox(): HTMLElement | null {
		if (!bodyEl) return null;
		let node: HTMLElement | null = bodyEl;
		while (node && node !== document.body) {
			if (node.scrollHeight > node.clientHeight + 1) return node;
			node = node.parentElement;
		}
		return null;
	}

	/** The headings the body renders, in the scroll box's own coordinates. */
	function headingsOf(box: HTMLElement): ReturnType<typeof headingOccurrences> {
		const body = bodyEl as HTMLElement | null;
		return headingOccurrences(body ?? document.createElement('div'), box);
	}

	function deviceStore(): Storage | null {
		try {
			return typeof localStorage === 'undefined' ? null : localStorage;
		} catch {
			return null;
		}
	}

	/** Saves where the body is now, once this device's store answers. */
	function recordPosition(box: HTMLElement): void {
		const saved = capture(headingsOf(box), box.scrollTop, box.scrollHeight);
		savePosition(deviceStore(), id, saved);
		if (saved.heading === positionAnchor) positionNote = null;
	}

	// Restore: the saved position, applied when the heading it names still exists; said when it
	// does not. The verdict is decided reactively — `anchorExists` reads the markdown source,
	// the one input that changes when the document's headings change — so a heading the saved
	// position names that the body no longer holds is said whatever the rendered state. The
	// scroll itself waits for the laid-out body: the sanitizer fills the article
	// asynchronously, so the seek is retried a bounded number of frames until the headings
	// render, and gives up honestly if they never do.
	$effect(() => {
		if (shown?.state !== 'opened') return;
		const markdown = shown.markdown;
		const saved = readPosition(deviceStore(), id);
		if (!saved || saved.heading === null) return;
		if (!anchorExists(saved.heading, markdown)) {
			positionNote = saved.heading;
			positionAnchor = null;
			return;
		}
		positionNote = null;
		positionAnchor = saved.heading;
		// The scroll: retried until the body's headings are laid out (the sanitizer fills the
		// body asynchronously), bounded — a document that renders no headings cannot be sought.
		const anchor = saved.heading;
		let frames = 0;
		let cancelled = false;
		const seek = () => {
			if (cancelled) return;
			const body = bodyEl;
			const box = body ? scrollBox() : null;
			if (body && box) {
				const headings = headingOccurrences(body, box);
				if (headings.length > 0) {
					const top = restoreTop(
						anchor,
						saved.fraction,
						headings,
						box.scrollHeight,
						box.clientHeight
					);
					if (top !== null) box.scrollTop = top;
					return;
				}
			}
			if (frames++ < 30) requestAnimationFrame(seek);
		};
		requestAnimationFrame(seek);
		return () => {
			cancelled = true;
		};
	});

	// Capture while the person reads, throttled to at most one record per second of stillness.
	let captureTimer: ReturnType<typeof setTimeout> | null = null;
	function onBodyScroll(): void {
		const box = scrollBox();
		if (!box || !bodyEl) return;
		if (captureTimer !== null) clearTimeout(captureTimer);
		captureTimer = setTimeout(() => {
			captureTimer = null;
			recordPosition(box);
		}, 1000);
	}

	$effect(() => {
		if (shown?.state !== 'opened') return;
		const box = scrollBox();
		if (!box) return;
		box.addEventListener('scroll', onBodyScroll, { passive: true });
		return () => {
			box.removeEventListener('scroll', onBodyScroll);
			if (captureTimer !== null) {
				clearTimeout(captureTimer);
				captureTimer = null;
				recordPosition(box);
			}
		};
	});

	function startEdit(): void {
		if (!doc) return;
		baseHash = doc.bodyHash;
		baseMarkdown = doc.markdown;
		draft = doc.markdown;
		seed = doc.markdown;
		refusal = null;
		saveFailed = '';
		editing = true;
	}

	function stopEditing(): void {
		editing = false;
		refusal = null;
		saveFailed = '';
		handoffState = { phase: 'idle' };
		intent = { freeText: '', oneClick: null };
		handoffUnavailable = '';
	}

	async function save(): Promise<void> {
		if (!doc || saving || !dirty) return;
		saving = true;
		saveFailed = '';
		try {
			const answer = await invoke<BodySaved>('doc_save_body', {
				id,
				baseHash,
				baseMarkdown,
				content: draft
			});
			saving = false;
			if (answer.state === 'saved') {
				// The room's base moves to what was written: the next save compares against it.
				baseHash = answer.bodyHash ?? baseHash;
				stopEditing();
				panelRefresh++;
				// The body the room renders is the room's own answer's; the host re-reads nothing —
				// show the saved text by re-opening through the room's own read path.
				await refresh();
			} else if (answer.state === 'refused') {
				refusal = answer;
			} else if (answer.state === 'unresolved') {
				saveFailed = `temper has nothing it would save here — ${answer.reason}`;
			} else {
				saveFailed = answer.message;
			}
		} catch (err) {
			saving = false;
			saveFailed = String(err);
		}
	}

	/** Re-read the document the room is about, through the same command the host used. */
	async function refresh(): Promise<void> {
		try {
			const fresh = await invoke<DocOpened>('doc_open', { id });
			// The host owns `opened`; the room shows the fresh answer by swapping its own view of
			// the document. The host's copy updates on its next open, which a tab switch re-keys.
			if (fresh.state === 'opened') {
				// The host handed us its state; the room renders from a local copy it can replace.
				localOpened = fresh;
			}
		} catch (err) {
			saveFailed = String(err);
		}
	}

	/** The room's view of the document: the host's answer until the room re-reads after a save. */
	let localOpened = $state<DocOpened | null>(null);
	const shown = $derived(localOpened ?? opened);
	/** Bumped after each landed save (body or metadata): the open panel tabs re-read against
	 * the saved state, in place. */
	let panelRefresh = $state(0);

	/**
	 * The metadata patch, built at save time from the strip's edit state: changed
	 * descriptions carry values, removed keys carry null (the API deletes an open_meta key
	 * on an explicit null), untouched keys are absent. Title is not the strip's.
	 */
	function buildMetaPatch(
		before: Record<string, unknown> | null,
		changed: Record<string, unknown>,
		removing: string[]
	): { openMeta: Record<string, unknown> } {
		const patch: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(changed)) patch[key] = value;
		for (const key of removing) patch[key] = null;
		return { openMeta: patch };
	}

	/** Save the strip's changed open-tier keys through the metadata channel, then re-read. */
	async function saveMeta(
		changed: Record<string, unknown>,
		removing: string[]
	): Promise<void> {
		if (!doc || saving) return;
		saving = true;
		saveFailed = '';
		try {
			const fresh = buildMetaPatch(doc.openMeta, changed, removing);
			const answer = await invoke<MetaSaved>('doc_save_meta', {
				id,
				patch: { openMeta: fresh.openMeta }
			});
			saving = false;
			if (answer.state === 'saved') {
				panelRefresh++;
				await refresh();
			} else if (answer.state === 'refused') {
				saveFailed = answer.reason;
			} else if (answer.state === 'unresolved') {
				saveFailed = `temper has nothing it would save here — ${answer.reason}`;
			} else {
				saveFailed = answer.message;
			}
		} catch (err) {
			saving = false;
			saveFailed = String(err);
		}
	}

	function takeNewer(): void {
		if (refusal && refusal.current.state === 'opened') {
			localOpened = refusal.current;
		}
		stopEditing();
	}

	function keepDraft(): void {
		if (refusal && refusal.current.state === 'opened') {
			// The person has seen the newer version; the draft is now measured against it.
			baseHash = refusal.current.bodyHash;
			baseMarkdown = refusal.current.markdown;
			localOpened = refusal.current;
			seed = draft;
			refusal = null;
			handoffState = { phase: 'idle' };
			// Stay in editing: the draft stands on the newer base.
		} else {
			stopEditing();
		}
	}

	/**
	 * Hands the disagreement to the agent: the trail is read once, the prompt composed from the
	 * refusal's material and sent through the live conversation, and the turn that follows is
	 * watched for the proposal. The turn ends in the transcript; the proposal is offered only
	 * through the person's "Apply" — it is never the room's own write.
	 */
	async function handToAgent(): Promise<void> {
		if (!refusal || refusal.current.state !== 'opened') return;
		const session = agentSession;
		if (!session.conversation) {
			handoffUnavailable = 'no agent conversation is live — start one in the agent panel';
			return;
		}
		if (!intentStated(intent)) {
			handoffUnavailable = 'say what you want the agent to do first';
			return;
		}
		handoffUnavailable = '';
		// The trail since the base: read once at hand time, bounded by the same read the
		// history tab uses, never kept beyond this send.
		let trail = '';
		try {
			const answer = await invoke<PanelRead<History>>('doc_history', { id });
			if (answer.state === 'present') {
				trail = trailSince(answer.data, opened?.state === 'opened' ? opened.updated : '', 20)
					.lines;
			}
		} catch {
			// The trail is context, not the material: a failed read sends the prompt without it.
		}
		const prompt = handoffPrompt(intent, {
			title: refusal.current.title,
			base: baseMarkdown,
			draft,
			newer: refusal.current.markdown
		}, trail);
		try {
			await session.sendHandoff(prompt);
			handoffState = { phase: 'sent' };
			// The turn is over (acp_prompt resolves when it ends): extract the proposal from
			// the transcript lines the turn's reply occupies.
			const start = session.handoffTurnStart();
			const reply = start !== null ? session.messages.slice(start).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n') : '';
			const proposal = proposalFrom(reply);
			session.handoff = null;
			if (proposal === null) {
				handoffState = { phase: 'none' };
				return;
			}
			handoffState = { phase: 'proposal', proposal };
		} catch {
			handoffState = { phase: 'idle' };
			// The session store carried the error; the person sees it in the panel.
		}
	}

	/**
	 * Applies the agent's proposal as the person's draft on the newer base — the return path's
	 * one gesture. The draft is re-seeded (a capture-once seed, the same shape keepDraft uses),
	 * and the person reviews and saves through compare-and-save. The proposal never enters the
	 * document by itself.
	 */
	function applyProposal(): void {
		if (handoffState.phase !== 'proposal' || !refusal || refusal.current.state !== 'opened') {
			return;
		}
		baseHash = refusal.current.bodyHash;
		baseMarkdown = refusal.current.markdown;
		localOpened = refusal.current;
		draft = handoffState.proposal;
		seed = handoffState.proposal;
		refusal = null;
		handoffState = { phase: 'idle' };
		intent = { freeText: '', oneClick: null };
		// Stay in editing: the proposal is the draft now, on the newer base, unsaved.
	}
</script>

<div class="page">
	{#if shown?.state === 'opened'}
		{@const d = shown}
		<div class="ed-strip">
			<span>{d.docType}</span>
			{#if d.contextRef}<span class="ed-strip-sep">·</span><span>{d.contextRef}</span>{/if}
			<span class="ed-strip-sep">·</span>
			<span>@{d.ownerHandle}</span>
			<span class="ed-strip-sep">·</span>
			<time datetime={d.updated} title={d.updated}>updated {ageWords(Date.parse(d.updated))}</time>
		</div>
		<div class="title-row">
			<h1 class="t-h2">{d.title}</h1>
			<div class="edit-actions">
				{#if editing}
					<button class="edit" type="button" onclick={stopEditing} disabled={saving}>
						Done
					</button>
					<button
						class="edit save"
						type="button"
						onclick={save}
						disabled={saving || !dirty}
					>
						{saving ? 'Saving…' : 'Save'}
					</button>
				{:else}
					<button class="edit" type="button" onclick={startEdit}>Edit</button>
				{/if}
			</div>
		</div>
		{#if refusal}
			<!-- The refusal takes the editor's place while it stands: the person reads it, then
			     chooses. The draft is kept either way until Take newer or a landed save closes it.
			     Slice 5: the intent field and the hand to the agent ride in the same view. -->
			<SaveRefusal
				refused={refusal}
				ontakeNewer={takeNewer}
				onkeepDraft={keepDraft}
				bind:intent
				handoffState={handoffState.phase}
				{handoffUnavailable}
				agentLive={agentSession.conversation !== null}
				onhandToAgent={handToAgent}
				onapplyProposal={applyProposal}
			/>
		{:else if editing}
			<!-- The seed is the draft when one stands (a refusal unmounted the editor; keeping
			     the draft remounts it with the person's text), else the document as opened. -->
			<DocumentEditor bind:value={draft} initial={seed} />
			<div class="ed-strip draft-strip">
				<span>{saving ? 'saving…' : dirty ? 'draft — not saved' : 'no changes yet'}</span>
				{#if saveFailed}<span class="failed">{saveFailed}</span>{/if}
			</div>
		{:else}
			<PropertySet
				rows={mergeProperties(d.managedMeta, d.openMeta, d.docType)}
				mayDescribe
				onsave={saveMeta}
			/>
		{/if}
	{:else if shown?.state === 'unresolved'}
		<RegionState
			state="empty"
			label="document at this reference"
			detail={`temper has nothing it would show here — ${shown.reason}`}
		/>
	{:else if shown?.state === 'failed'}
		<RegionState state="failed" label="this document" detail={shown.message} />
	{:else}
		<RegionState state="arriving" label="the document" />
	{/if}

	{#if shown?.state !== 'unresolved'}
		<AboutPanel {id} refreshKey={panelRefresh} />
	{/if}

	{#if shown?.state === 'opened'}
		{#if positionNote}
			<p class="t-strip position-note" role="note">
				This device held a position at {positionNote} — that heading is no longer in this
				document, so the room starts at the top.
			</p>
		{/if}
		<article class="body" bind:this={bodyEl}>
			<MarkdownRenderer markdown={shown.markdown} />
		</article>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: 1.2rem;
		max-width: 44rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
	h1 {
		margin: 0.6rem 0 0;
	}
	.title-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}
	.edit {
		flex: none;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		color: var(--tp-text);
		padding: 0.15rem 0.7rem;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.edit:hover:not(:disabled) {
		background: var(--tp-accent-wash);
		border-color: var(--tp-accent-line);
	}
	.edit:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.save {
		border-color: var(--tp-accent-line);
	}
	.draft-strip {
		color: var(--tp-text-subtle);
	}
	.draft-strip .failed {
		color: var(--tp-danger);
	}
	.body {
		padding-top: 0.6rem;
	}
	.position-note {
		margin: 0;
		color: var(--tp-text-subtle);
	}
</style>