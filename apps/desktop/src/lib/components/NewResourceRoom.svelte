<script lang="ts">
	/**
	 * The create room: a new resource in one named context. Reached from that context's
	 * room through the palette — the context rides the place, so back-trail and reopen
	 * keep it. Creation is metadata-only: the title and the doctype go to `doc_create`,
	 * the chosen doctype's open-tier defaults ride the metadata door (`doc_save_meta`)
	 * once the create lands, and the body is written in the room the tab then opens.
	 *
	 * The target context is resolved against live reads of what temper answers; with
	 * temper unreachable nothing validates and nothing is created.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import RegionState from '$lib/components/RegionState.svelte';
	import type { DocCreated, MetaSaved } from '$lib/document';
	import { temperViews } from '$lib/temper-views.svelte';
	import { enabled } from '$lib/shell/contributions';
	import { createMenu, type CreateOption, type TabHandle } from '$lib/shell/lenses';

	let { tab, context }: { tab: TabHandle; context?: string } = $props();

	let doctype = $state<string | null>(null);
	let title = $state('');
	let submitting = $state(false);
	let failure = $state('');

	/** The create menu, the doctypes the enabled contributions offer. */
	const menu = $derived(createMenu(enabled, today()));
	/** The chosen doctype — the menu's first unless a choice was made. */
	const chosen = $derived(doctype ?? menu[0]?.doctype ?? null);

	/** The target context, resolved against what temper answers — null until a read says. */
	const resolved = $derived(
		context
			? (temperViews.contexts?.find((c) => `${c.ownerRef}/${c.slug}` === context) ?? null)
			: null
	);

	const canCreate = $derived(Boolean(resolved && chosen && title.trim()));

	onMount(() => {
		// Fresh reads: the room resolves the target against what temper says now.
		void temperViews.refreshContexts();
	});

	function refreshReads(): void {
		void temperViews.refreshContexts();
	}

	/** The create-time date, in this device's days — `YYYY-MM-DD`. */
	function today(): string {
		const now = new Date();
		const month = `${now.getMonth() + 1}`.padStart(2, '0');
		const day = `${now.getDate()}`.padStart(2, '0');
		return `${now.getFullYear()}-${month}-${day}`;
	}

	/** The caches that list resources, re-read so the created one is there when looked for. */
	async function refreshCaches(): Promise<void> {
		const reads: Promise<void>[] = [temperViews.refreshRecent()];
		for (const group of enabled) {
			for (const way of group.waysIn) {
				if (way.source === 'list') {
					reads.push(temperViews.refreshList(`${group.plugin}/${way.id}`, way.filter));
				}
			}
		}
		await Promise.all(reads);
	}

	async function submit(): Promise<void> {
		if (!canCreate || submitting) return;
		submitting = true;
		failure = '';
		try {
			// The defaults are asked with the create-time date, not the room's opening one.
			const option: CreateOption | undefined = createMenu(enabled, today()).find(
				(o) => o.doctype === chosen
			);
			const answer = await invoke<DocCreated>('doc_create', {
				contextId: resolved?.id,
				docType: chosen,
				title: title.trim()
			});
			if (answer.state !== 'created') {
				// The create did not land. The line names what failed; the form stands so
				// Create can be pressed again at once. (The refused and failed answers carry
				// the idempotency key a converging retry reuses — `doc_create` mints it and
				// takes none from here, so the reuse itself is not yet sendable.)
				failure = answer.state === 'refused' ? answer.reason : answer.message;
				return;
			}
			if (option?.defaults) {
				const saved = await invoke<MetaSaved>('doc_save_meta', {
					id: answer.id,
					patch: { openMeta: option.defaults }
				});
				// A defaults save that did not land leaves the create standing: the tab still
				// opens, and the document room's meta strip shows what is actually there.
				void saved;
			}
			await refreshCaches();
			tab.open({ kind: 'resource', id: answer.id }, 'here');
		} catch (err) {
			failure = String(err);
		} finally {
			submitting = false;
		}
	}
</script>

<div class="page">
	<div class="ed-strip">
		<span>new resource</span><span class="ed-strip-sep">·</span>
		<span>{resolved ? `in ${resolved.name}` : 'in a context'}</span>
	</div>

	<h1 class="t-h2">A <em>new resource</em></h1>

	<p class="t-body">
		Choose what it is and name it — temper creates it in the context, and the tab opens on
		it. The body is written once it exists; nothing is created until you say so.
	</p>

	<p class="t-label">In the context</p>
	<section class="ed-rail">
		{#if !context}
			<RegionState
				state="empty"
				label="context named"
				detail="Open this room from a context room."
			/>
		{:else if temperViews.contextsError}
			<RegionState state="failed" label="your contexts" detail={temperViews.contextsError} />
			<button class="ed-action" onclick={refreshReads}>Try again</button>
		{:else if !temperViews.contexts}
			<RegionState state="arriving" label="your contexts" />
		{:else if resolved}
			<p class="t-strip" role="status">{resolved.name} — {resolved.ownerRef}/{resolved.slug}</p>
		{:else}
			<p class="ed-notice" role="status">
				<strong>{context}</strong> is not among the contexts temper answers — nothing can be
				created here.
			</p>
			<button class="ed-action" onclick={refreshReads}>Try again</button>
		{/if}
	</section>

	<p class="t-label">The resource</p>
	<section class="ed-rail">
		<label class="field">
			<span class="t-strip">What it is</span>
			<select
				value={chosen ?? ''}
				onchange={(e) => (doctype = e.currentTarget.value)}
				disabled={!resolved}
			>
				{#each menu as option (option.doctype)}
					<option value={option.doctype}>{option.doctype}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			<span class="t-strip">Title</span>
			<input
				bind:value={title}
				placeholder="What it is called"
				disabled={!resolved}
			/>
		</label>

		<div class="actions">
			<button
				class="ed-action ed-action--primary"
				onclick={submit}
				disabled={submitting || !canCreate}
			>
				{submitting ? 'Creating…' : 'Create'}
			</button>
		</div>
		{#if failure}
			<p class="ed-notice" role="alert">Not created — {failure}</p>
		{/if}
	</section>
</div>

<style>
	.page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2rem 1.5rem 4rem;
	}
	h1 {
		margin: 2.5rem 0 2rem;
	}
	.t-body {
		margin: 0 0 2rem;
		max-width: 36rem;
	}
	.t-label {
		margin: 0 0 0.8rem;
	}
	.ed-rail {
		margin-bottom: 3rem;
		display: grid;
		gap: 0.8rem;
		justify-items: start;
	}
	.field {
		display: grid;
		gap: 0.4rem;
		width: 100%;
	}
	select,
	input {
		box-sizing: border-box;
		width: 100%;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface-raised);
		color: var(--tp-text);
		font: 0.85rem var(--tp-font-ui);
	}
	input {
		font-family: var(--tp-font-doing);
	}
	select:focus,
	input:focus {
		border-color: var(--tp-accent-line);
		outline: none;
	}
	.actions {
		display: flex;
		align-items: baseline;
		gap: 1rem;
	}
</style>
