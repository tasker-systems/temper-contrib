<script lang="ts">
	/**
	 * The create room: a new resource in one named context. Reached from that context's
	 * room through the palette — the context rides the place, so back-trail and reopen
	 * keep it. Creation is metadata-only: the title and the doctype go to `doc_create`,
	 * the chosen doctype's open-tier defaults ride the metadata door (`doc_save_meta`)
	 * once the create lands, and the body is written in the room the tab then opens.
	 * Once the create lands the form is done: a later failure is post-landing — the
	 * tab still opens on the resource, one honest line says what failed to ride along,
	 * and Create never comes back.
	 *
	 * The target context is resolved against this session's reads of what temper
	 * answers — never a cache a failed re-read left behind; until a read says,
	 * nothing validates and nothing is created.
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
	/** The pre-create refusal or failure: the create did not land. One line, and the
	 * form stands so Create can be pressed again at once. */
	let createError = $state('');
	/** The key a refused or failed create echoed, held for this form's next submit — kept even
	 * if the fields change: the server dedups on owner+key, and converging is the desired outcome. */
	let retryKey = $state<string | null>(null);
	/** The doctype the retained key was last sent with: a retry can converge on that
	 * earlier-committed resource, doctype included — what the defaults stamp reads. */
	let keyDoctype = $state<string | null>(null);
	/** The created id once the create landed. The form is done from here on: any later
	 * failure is post-landing — the tab still opens, and Create never comes back. */
	let landed = $state<string | null>(null);
	/** What failed to ride along after the landing, in one honest line. */
	let rideAlongError = $state('');

	/** The create menu, the doctypes the enabled contributions offer. */
	const menu = $derived(createMenu(enabled, today()));
	/** The chosen doctype — the menu's first unless a choice was made. */
	const chosen = $derived(doctype ?? menu[0]?.doctype ?? null);

	/** This session's reads: a create is validated against what temper said *now*,
	 * never against a cache a failed re-read left behind. */
	const readsFresh = $derived(temperViews.contextsFresh);
	/** The target context, resolved against this session's read — null until it says. */
	const resolved = $derived(
		context && readsFresh
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
		if (!canCreate || submitting || landed) return;
		submitting = true;
		createError = '';
		try {
			// The defaults are asked with the create-time date, not the room's opening one.
			const option: CreateOption | undefined = createMenu(enabled, today()).find(
				(o) => o.doctype === chosen
			);
			const answer = await invoke<DocCreated>('doc_create', {
				contextId: resolved?.id,
				docType: chosen,
				title: title.trim(),
				...(retryKey === null ? {} : { idempotencyKey: retryKey })
			});
			if (answer.state !== 'created') {
				// The create did not land. The line names what failed; the form stands so
				// Create can be pressed again at once, resending the echoed key — the
				// retry converges on whatever already committed instead of duplicating.
				createError = answer.state === 'refused' ? answer.reason : answer.message;
				retryKey = answer.idempotencyKey;
				keyDoctype = chosen;
				return;
			}
			// The create landed: its key is spent, the form is done, and everything after
			// this line is post-landing — a failure rides along as one honest line, the
			// tab still opens, and Create never comes back.
			const sentAs = retryKey === null ? null : keyDoctype;
			retryKey = null;
			keyDoctype = null;
			landed = answer.id;
			rideAlongError = await rideAlong(answer.id, option, sentAs);
		} catch (err) {
			createError = String(err);
		} finally {
			submitting = false;
		}
	}

	/**
	 * Everything the create promises once it has landed: the chosen doctype's defaults
	 * stamp through the metadata door, the caches re-read so the resource is there when
	 * looked for, and the tab opens on the resource. Nothing here throws — what fails is
	 * answered as the honest line; the landing itself stands.
	 */
	async function rideAlong(
		id: string,
		option: CreateOption | undefined,
		/** The doctype a retained key was last sent with, when one rode — a retry
		 * converging on that earlier resource converges on its doctype too. */
		sentAs: string | null
	): Promise<string> {
		let rodeWith = '';
		if (option?.defaults) {
			if (sentAs !== null && sentAs !== chosen) {
				// The convergence tradeoff: the retry landed on the earlier-committed
				// resource, whose doctype is the one the key was first sent with, so this
				// choice's defaults would stamp one vocabulary's metadata over another's.
				// The skipped stamp is the cheap loss — the room's meta editor stamps by
				// hand — where the wrong-vocabulary stamp is not.
				rodeWith = `it kept its ${sentAs} type, so the ${chosen} defaults were not stamped`;
			} else {
				try {
					const saved = await invoke<MetaSaved>('doc_save_meta', {
						id,
						patch: { openMeta: option.defaults }
					});
					// A defaults save that did not land — refused, unresolved, failed or
					// thrown — is a ride-along failure, not a lost landing: the line says
					// so, and the document room's meta strip shows what is actually there.
					rodeWith =
						saved.state === 'saved'
							? ''
							: `its defaults did not land — ${
									saved.state === 'failed' ? saved.message : saved.reason
								}`;
				} catch (err) {
					rodeWith = `its defaults did not land — ${String(err)}`;
				}
			}
		}
		try {
			await refreshCaches();
		} catch (err) {
			rodeWith = rodeWith || `the lists were not re-read — ${String(err)}`;
		}
		tab.open({ kind: 'resource', id }, 'here');
		return rodeWith;
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
		{:else if !temperViews.contexts || !temperViews.contextsFresh}
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
		{#if landed}
			{#if rideAlongError}
				<p class="ed-notice" role="status">Created — but {rideAlongError}.</p>
			{/if}
		{:else}
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
			{#if createError}
				<p class="ed-notice" role="alert">Not created — {createError}</p>
			{/if}
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
