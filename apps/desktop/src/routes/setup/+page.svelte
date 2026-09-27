<script lang="ts">
	/**
	 * The setup room: choose, validate, and if need be create the person context
	 * the app stores the person's facts in. Reached only from the chrome's menu —
	 * never launched on the app's behalf, and re-runnable any time.
	 *
	 * Validation is against the person's live context list, and only a context
	 * owned by the signed-in person (`@<handle>` — the `@me` target) resolves.
	 * With temper unreachable, nothing validates and nothing saves: the settings
	 * room's raw field is the offline path, not this one.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import RegionState from '$lib/components/RegionState.svelte';
	import {
		DEFAULT_TEMPER_CONTEXT,
		ownContextsOf,
		temperViews
	} from '$lib/temper-views.svelte';

	let configured = $state<string | null>(null);
	let name = $state('');
	let justSaved = $state(false);
	let saving = $state(false);
	let saveError = $state('');
	let creating = $state(false);
	let createError = $state('');
	let loadError = $state('');

	const effectiveName = $derived(name.trim());
	const saved = $derived(justSaved && effectiveName === configured);

	const handle = $derived(temperViews.profileIdentity?.handle ?? null);
	/** The person's own contexts — the only ones that can be the person context. `null` until a read says. */
	const ownContexts = $derived(ownContextsOf(temperViews.profileIdentity, temperViews.contexts));
	/** This session's reads: a save is validated against what temper said *now*,
	 * never against a cache a failed re-read left behind. */
	const readsFresh = $derived(temperViews.profileFresh && temperViews.contextsFresh);
	const readingFailed = $derived(Boolean(temperViews.profileError || temperViews.contextsError));
	const identityMissing = $derived(
		temperViews.contextsFresh && !temperViews.profileFresh && !temperViews.profileError
	);

	type Resolution = 'unreachable' | 'unknown' | 'empty' | 'resolves' | 'missing';
	const resolution = $derived.by<Resolution>(() => {
		if (temperViews.connected === false) return 'unreachable';
		if (ownContexts === null || !readsFresh) return 'unknown';
		if (!effectiveName) return 'empty';
		return ownContexts.some((c) => c.name === effectiveName) ? 'resolves' : 'missing';
	});
	/** The only state a save is accepted in: the name resolves against live reads. */
	const canSave = $derived(resolution === 'resolves');
	const resolvedContext = $derived(
		ownContexts?.find((c) => c.name === effectiveName) ?? null
	);

	onMount(async () => {
		try {
			const settings = await invoke<{ temperContext?: string | null }>('settings_get');
			configured = settings.temperContext ?? null;
			name = configured ?? DEFAULT_TEMPER_CONTEXT;
		} catch (e) {
			loadError = String(e);
		}
		// Fresh reads: this room validates against what temper says *now*.
		void temperViews.refreshProfile();
		void temperViews.refreshContexts();
	});

	function refreshReads(): void {
		void temperViews.refreshProfile();
		void temperViews.refreshContexts();
	}

	async function createContext(): Promise<void> {
		creating = true;
		createError = '';
		try {
			await invoke('temper_context_create', { name: effectiveName });
			await temperViews.refreshContexts();
		} catch (e) {
			createError = String(e);
		} finally {
			creating = false;
		}
	}

	async function save(): Promise<void> {
		saving = true;
		justSaved = false;
		saveError = '';
		try {
			await invoke('settings_set_temper_context', { name: effectiveName });
			configured = effectiveName;
			justSaved = true;
		} catch (e) {
			saveError = String(e);
		} finally {
			saving = false;
		}
	}
</script>

<main class="page">
	<div class="ed-strip">
		<span>setup</span><span class="ed-strip-sep">·</span>
		<span>choose where the app stores your facts</span>
	</div>

	<h1 class="t-h2">The <em>setup</em> room</h1>

	{#if loadError}
		<RegionState state="failed" label="device settings" detail={loadError} />
	{/if}

	<p class="t-body">
		The app keeps your facts — your work record, your preferences that follow you — in one
		context of your own. Name it here; temper is asked before anything is saved.
	</p>

	<p class="t-label">Person context</p>
	<section class="ed-rail">
		<label class="field">
			<span class="t-strip">Context name</span>
			<input bind:value={name} placeholder={DEFAULT_TEMPER_CONTEXT} />
		</label>

		{#if resolution === 'unreachable'}
			<RegionState state="failed" label="temper" detail={temperViews.connectError} />
			<p class="ed-notice" role="status">
				Temper is unreachable, so the name cannot be validated — nothing was saved. Try again
				when the connection is back, or use the settings room's raw field if you must.
			</p>
		{:else if resolution === 'unknown'}
			{#if identityMissing || temperViews.profileError}
				<RegionState state="gave-up" label="your identity" />
			{:else if temperViews.contextsError}
				<RegionState state="gave-up" label="your contexts" />
			{:else if temperViews.profileError && temperViews.contextsError}
				<RegionState state="gave-up" label="temper" />
			{:else}
				<RegionState state="arriving" label="your contexts" />
			{/if}
			{#if readingFailed || identityMissing}
				<button class="ed-action" onclick={refreshReads}>Try again</button>
			{/if}
		{:else if resolution === 'empty'}
			<p class="t-strip" role="status">Name a context, or choose one below.</p>
		{:else if resolution === 'resolves' && resolvedContext}
			<p class="t-strip" role="status">
				resolves — {resolvedContext.ownerRef}/{resolvedContext.slug}
			</p>
		{:else if resolution === 'missing'}
			<p class="ed-notice" role="status">
				<strong>{effectiveName}</strong> is not among your contexts.
			</p>
		{/if}

		<div class="actions">
			<button
				class="ed-action ed-action--primary"
				onclick={save}
				disabled={saving || !canSave || saved}
			>
				{saving ? 'Saving…' : 'Save'}
			</button>
			{#if saved}<span class="t-strip" role="status">saved</span>{/if}
		</div>
		{#if saveError}
			<p class="ed-notice" role="alert">
				Not saved — the person context on this machine is unchanged. {saveError}
			</p>
		{/if}
	</section>

	<p class="t-label">Your contexts</p>
	<section class="ed-rail">
		{#if resolution === 'unreachable' || resolution === 'unknown'}
			<p class="t-strip">Temper says what exists — the list waits for the reads above.</p>
		{:else if ownContexts && ownContexts.length > 0}
			<ul class="choices">
				{#each ownContexts as context (context.id)}
					<li>
						<button class="choice" onclick={() => (name = context.name)}>
							<span class="t-strip">{context.name}</span>
							{#if context.name === configured}<span class="t-strip in-use">in use</span>{/if}
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="t-strip" role="status">
				You have no contexts of your own yet. Creating one names it and starts it empty.
			</p>
		{/if}

		{#if resolution === 'missing' || (ownContexts !== null && ownContexts.length === 0)}
			<div class="actions">
				<button class="ed-action" onclick={createContext} disabled={creating || !effectiveName}>
					{creating ? 'Creating…' : `create ${effectiveName || DEFAULT_TEMPER_CONTEXT}`}
				</button>
			</div>
			{#if createError}
				<p class="ed-notice" role="alert">Not created. {createError}</p>
			{/if}
		{/if}
	</section>
</main>

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
	input {
		box-sizing: border-box;
		width: 100%;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		color: var(--tp-text);
		font: 0.85rem var(--tp-font-doing);
	}
	input:focus {
		border-color: var(--tp-accent-line);
		outline: none;
	}
	.actions {
		display: flex;
		align-items: baseline;
		gap: 1rem;
	}
	.choices {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.4rem;
		width: 100%;
	}
	.choice {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		width: 100%;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		color: var(--tp-text);
		font: 0.85rem var(--tp-font-doing);
		cursor: pointer;
		text-align: left;
	}
	.choice:hover {
		border-color: var(--tp-accent-line);
	}
	.in-use {
		color: var(--tp-accent);
	}
</style>
