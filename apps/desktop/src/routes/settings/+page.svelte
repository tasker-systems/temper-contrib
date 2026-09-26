<script lang="ts">
	/**
	 * The settings room: the device's preferences. Bounded and closable — it holds
	 * Appearance and Agents, and stays silent about what it does not hold. Device
	 * facts stay on this machine; what follows the person is temper's, later work.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import RegionState from '$lib/components/RegionState.svelte';
	import ThemeSwitch from '$lib/ThemeSwitch.svelte';

	let workingDir = $state('');
	let saved = $state(false);
	let saving = $state(false);
	let error = $state('');

	onMount(async () => {
		try {
			const settings = await invoke<{ workingDir?: string | null }>('settings_get');
			workingDir = settings.workingDir ?? '';
		} catch (e) {
			error = String(e);
		}
	});

	async function saveWorkingDir(): Promise<void> {
		saving = true;
		saved = false;
		error = '';
		try {
			await invoke('settings_set_working_dir', { dir: workingDir });
			saved = true;
		} catch (e) {
			error = String(e);
		} finally {
			saving = false;
		}
	}
</script>

<main class="page">
	<div class="ed-strip">
		<span>settings</span><span class="ed-strip-sep">·</span>
		<span>device facts — they stay on this machine</span>
	</div>

	<h1 class="t-h2">The <em>settings</em> room</h1>

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
			<button class="ed-action ed-action--primary" onclick={saveWorkingDir} disabled={saving}>
				{saving ? 'Saving…' : 'Save'}
			</button>
			{#if saved}<span class="t-strip" role="status">saved</span>{/if}
		</div>
	</section>

	{#if error}
		<RegionState state="failed" label="saving the working directory" detail={error} />
	{/if}
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
