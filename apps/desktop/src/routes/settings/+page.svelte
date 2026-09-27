<script lang="ts">
	/**
	 * The settings room: the device's preferences. Bounded and closable — it holds
	 * Appearance, Agents, and the temper context the person's facts land in, and
	 * stays silent about what it does not hold. Device facts stay on this
	 * machine; the temper context names where person facts go.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import RegionState from '$lib/components/RegionState.svelte';
	import ThemeSwitch from '$lib/ThemeSwitch.svelte';
	import { ageWords, DEFAULT_TEMPER_CONTEXT, ownContextsOf, temperViews } from '$lib/temper-views.svelte';

	let workingDir = $state('');
	/** What the store holds, as last read or saved — the baseline "saved" is measured against. */
	let stored = $state('');
	let saving = $state(false);
	let justSaved = $state(false);
	/** Reading the store and writing to it fail differently, so they are held apart. */
	let loadError = $state('');
	let saveError = $state('');

	let temperContext = $state('');
	let storedContext = $state('');
	let savingContext = $state(false);
	let justSavedContext = $state(false);
	let saveContextError = $state('');

	const dirty = $derived(workingDir !== stored);
	// "saved" holds only while the field still shows what was saved; an edit retracts it.
	const saved = $derived(justSaved && !dirty);
	const contextDirty = $derived(temperContext !== storedContext);
	const contextSaved = $derived(justSavedContext && !contextDirty);

	// What the configured name resolves to, read from the temper views the whole app
	// shares. This field is the raw editor; only the setup room validates and saves
	// against live reads — here the status says what the last read knew.
	const effectiveContext = $derived(temperContext.trim() || DEFAULT_TEMPER_CONTEXT);
	const ownContexts = $derived(ownContextsOf(temperViews.profileIdentity, temperViews.contexts));
	const contextResolves = $derived(
		ownContexts?.some((c) => c.name === effectiveContext) ?? null
	);
	const contextStatus = $derived.by(() => {
		if (contextResolves === null) return 'not checked yet — the setup room validates it';
		const decorated = `@${temperViews.profileIdentity?.handle ?? ''}/${ownContexts?.find((c) => c.name === effectiveContext)?.slug ?? effectiveContext}`;
		if (contextResolves) {
			return temperViews.contextsFresh
				? `resolves — ${decorated}`
				: `resolves on the last read, ${ageWords(temperViews.contextsFetchedAt ?? 0)} ago — the setup room re-checks`;
		}
		return 'not found among your contexts — the setup room can create it';
	});

	onMount(async () => {
		try {
			const settings = await invoke<{
				workingDir?: string | null;
				temperContext?: string | null;
			}>('settings_get');
			workingDir = stored = settings.workingDir ?? '';
			temperContext = storedContext = settings.temperContext ?? '';
		} catch (e) {
			loadError = String(e);
		}
	});

	async function saveWorkingDir(): Promise<void> {
		saving = true;
		justSaved = false;
		saveError = '';
		const value = workingDir;
		try {
			await invoke('settings_set_working_dir', { dir: value });
			stored = value;
			justSaved = true;
		} catch (e) {
			saveError = String(e);
		} finally {
			saving = false;
		}
	}

	async function saveTemperContext(): Promise<void> {
		savingContext = true;
		justSavedContext = false;
		saveContextError = '';
		const value = temperContext;
		try {
			await invoke('settings_set_temper_context', { name: value });
			storedContext = value;
			justSavedContext = true;
		} catch (e) {
			saveContextError = String(e);
		} finally {
			savingContext = false;
		}
	}
</script>

<main class="page">
	<div class="ed-strip">
		<span>settings</span><span class="ed-strip-sep">·</span>
		<span>device facts — they stay on this machine</span>
	</div>

	<h1 class="t-h2">The <em>settings</em> room</h1>

	{#if loadError}
		<RegionState state="failed" label="device settings" detail={loadError} />
	{/if}

	<p class="t-label">Appearance</p>
	<section class="ed-rail">
		<ThemeSwitch />
	</section>

	<p class="t-label">Agents</p>
	<section class="ed-rail">
		<label class="field">
			<span class="t-strip">Default working directory</span>
			<input bind:value={workingDir} placeholder="/path/to/project" />
		</label>
		<div class="actions">
			<button class="ed-action ed-action--primary" onclick={saveWorkingDir} disabled={saving || !dirty}>
				{saving ? 'Saving…' : 'Save'}
			</button>
			{#if saved}<span class="t-strip" role="status">saved</span>{/if}
		</div>
		{#if saveError}
			<p class="ed-notice" role="alert">
				Not saved — the working directory on this machine is unchanged. {saveError}
			</p>
		{/if}
	</section>

	<p class="t-label">Temper</p>
	<section class="ed-rail">
		<label class="field">
			<span class="t-strip">Person context</span>
			<input bind:value={temperContext} placeholder="temper-desktop" />
		</label>
		<div class="actions">
			<button
				class="ed-action ed-action--primary"
				onclick={saveTemperContext}
				disabled={savingContext || !contextDirty}
			>
				{savingContext ? 'Saving…' : 'Save'}
			</button>
			{#if contextSaved}<span class="t-strip" role="status">saved</span>{/if}
		</div>
		{#if saveContextError}
			<p class="ed-notice" role="alert">
				Not saved — the temper context on this machine is unchanged. {saveContextError}
			</p>
		{/if}
		<p class="t-strip">{contextStatus}</p>
		<a class="t-action" href="/setup">set up the app…</a>
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
</style>
