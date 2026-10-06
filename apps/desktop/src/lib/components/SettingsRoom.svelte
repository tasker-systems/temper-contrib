<script lang="ts">
	/**
	 * The settings room: the device's preferences. Bounded and closable — it holds
	 * Appearance, Agents, the temper context the person's facts land in, and this
	 * device's label, and stays silent about what it does not hold. Device facts stay on this
	 * machine; the temper context names where person facts go.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import RegionState from '$lib/components/RegionState.svelte';
	import ThemeSwitch from '$lib/ThemeSwitch.svelte';
	import { ageWords, DEFAULT_TEMPER_CONTEXT, ownContextsOf, temperViews } from '$lib/temper-views.svelte';
	import { placeHref } from '$lib/shell/subjects';

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

	let deviceLabel = $state('');
	let storedLabel = $state('');
	let savingLabel = $state(false);
	let justSavedLabel = $state(false);
	let saveLabelError = $state('');

	// The temper connection: custody of the grant is the desktop's own, and
	// sign-out ends it. The corner follows the re-queried state, so the room
	// only reports and acts.
	let signingOut = $state(false);
	let signOutError = $state('');

	async function signOut(): Promise<void> {
		signingOut = true;
		signOutError = '';
		try {
			await invoke('temper_signout');
		} catch (e) {
			signOutError = String(e);
		} finally {
			signingOut = false;
		}
		// The connection is asked again, so the corner follows without a restart.
		await temperViews.refreshProfile();
	}

	// Agents by configuration: the store's roster, and the form for adding or
	// changing one. `agentKey` names the entry being edited; an empty key means
	// the form is adding a new one under the key the person typed.
	type AgentLaunch = { label?: string | null; command?: string | null; binaryPath?: string | null };
	let agents = $state<Record<string, AgentLaunch>>({});
	let agentKey = $state('');
	let agentLabel = $state('');
	let agentCommand = $state('');
	let agentsError = $state('');
	let agentNotice = $state('');

	// The ACP roster: launch presets for the common agents, as shipped data.
	// An entry whose binary is not on $PATH offers nothing — its row does not
	// render. Already-configured keys drop out of the offers too: selecting a
	// preset that is already configured is not a choice the room shows.
	type RosterOffer = {
		key: string;
		label: string;
		binary: string;
		command: string;
		status: 'present' | 'absent' | 'noCommand';
	};
	let roster = $state<RosterOffer[]>([]);
	let rosterError = $state('');

	const rosterOffers = $derived(
		roster.filter((r) => r.status === 'present' && !(r.key in agents))
	);

	async function refreshRoster(): Promise<void> {
		try {
			const offers = await invoke<unknown>('roster_get');
			// A read that answers something other than the roster is a failed
			// read, not an empty one — adopting null here would render the
			// section as if $PATH held nothing.
			if (!Array.isArray(offers)) throw new Error('the roster did not read as a list');
			roster = offers as RosterOffer[];
			rosterError = '';
		} catch (e) {
			rosterError = String(e);
		}
	}

	async function selectPreset(offer: RosterOffer): Promise<void> {
		agentsError = '';
		agentNotice = '';
		try {
			await invoke('settings_set_agent', {
				key: offer.key,
				launch: { label: offer.label, command: offer.command }
			});
			const settings = await invoke<{ agents?: Record<string, AgentLaunch> }>('settings_get');
			agents = settings.agents ?? {};
			agentNotice = `added ${offer.label} from the ACP roster`;
		} catch (e) {
			agentsError = String(e);
		}
	}

	const dirty = $derived(workingDir !== stored);
	// "saved" holds only while the field still shows what was saved; an edit retracts it.
	const saved = $derived(justSaved && !dirty);
	const contextDirty = $derived(temperContext !== storedContext);
	const contextSaved = $derived(justSavedContext && !contextDirty);
	const labelDirty = $derived(deviceLabel !== storedLabel);
	const labelSaved = $derived(justSavedLabel && !labelDirty);

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
				deviceLabel?: string | null;
				agents?: Record<string, AgentLaunch>;
			}>('settings_get');
			deviceLabel = storedLabel = settings.deviceLabel ?? '';
			workingDir = stored = settings.workingDir ?? '';
			temperContext = storedContext = settings.temperContext ?? '';
			agents = settings.agents ?? {};
		} catch (e) {
			loadError = String(e);
		}
		await refreshRoster();
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

	async function saveDeviceLabel(): Promise<void> {
		savingLabel = true;
		justSavedLabel = false;
		saveLabelError = '';
		const value = deviceLabel;
		try {
			await invoke('settings_set_device_label', { label: value });
			storedLabel = value.trim();
			deviceLabel = storedLabel;
			justSavedLabel = true;
		} catch (e) {
			saveLabelError = String(e);
		} finally {
			savingLabel = false;
		}
	}

	/** Saves one agent's launch facts under its key, then re-reads the roster
	 *  through the same store the panel reads — the picker and this room
	 *  agree, because both read the device store. */
	async function saveAgent(): Promise<void> {
		agentsError = '';
		agentNotice = '';
		const key = agentKey.trim();
		if (!key) {
			agentsError = 'An agent needs a key — the word the picker shows it by.';
			return;
		}
		try {
			await invoke('settings_set_agent', {
				key,
				launch: { label: agentLabel.trim() || key, command: agentCommand.trim() }
			});
			const settings = await invoke<{ agents?: Record<string, AgentLaunch> }>('settings_get');
			agents = settings.agents ?? {};
			agentNotice = `saved ${key}`;
			agentKey = '';
			agentLabel = '';
			agentCommand = '';
		} catch (e) {
			agentsError = String(e);
		}
	}

	async function removeAgent(key: string): Promise<void> {
		agentsError = '';
		agentNotice = '';
		try {
			await invoke('settings_remove_agent', { key });
			const settings = await invoke<{ agents?: Record<string, AgentLaunch> }>('settings_get');
			agents = settings.agents ?? {};
			agentNotice = `removed ${key}`;
		} catch (e) {
			agentsError = String(e);
		}
	}

	function editAgent(key: string): void {
		const a = agents[key];
		agentKey = key;
		agentLabel = a?.label ?? key;
		agentCommand = a?.command ?? '';
		agentNotice = '';
		agentsError = '';
	}
</script>

<div class="page">
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

	<p class="t-label">Configured agents</p>
	<section class="ed-rail">
		<p class="t-strip">
			{#if Object.keys(agents).length === 0}
				none configured — the agent panel offers nothing until one is added here
			{:else}
				{Object.keys(agents).length} configured{Object.keys(agents).length === 1 ? '' : 's'} —
				launch specs and labels live in this machine's device store
			{/if}
		</p>
		{#if rosterError}
			<p class="ed-notice" role="alert">
				The ACP roster could not be read — the hand configuration below still works. {rosterError}
			</p>
		{/if}
		{#if rosterOffers.length > 0}
			<div class="roster" aria-label="Agents the ACP roster offers">
				<p class="t-strip">
					from the <a href="https://agentclientprotocol.com/get-started/agents" target="_blank" rel="noreferrer">ACP roster</a>,
					on this machine's path
				</p>
				<ul class="agent-list">
					{#each rosterOffers as offer (offer.key)}
						<li>
							<span class="agent-name">{offer.label}</span>
							<code class="agent-command">{offer.command}</code>
							<button class="t-action" onclick={() => selectPreset(offer)}>add</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		<ul class="agent-list">
			{#each Object.entries(agents) as [key, launch] (key)}
				<li>
					<span class="agent-name">{launch.label ?? key}</span>
					<code class="agent-command">{launch.command}</code>
					<button class="t-action" onclick={() => editAgent(key)}>edit</button>
					<button class="t-action" onclick={() => removeAgent(key)}>remove</button>
				</li>
			{/each}
		</ul>
		<div class="agent-form" aria-label="Add or change an agent">
			<label class="field">
				<span class="t-strip">Key</span>
				<input bind:value={agentKey} placeholder="opencode" />
			</label>
			<label class="field">
				<span class="t-strip">Label</span>
				<input bind:value={agentLabel} placeholder="shown in the picker (defaults to the key)" />
			</label>
			<label class="field">
				<span class="t-strip">Launch command</span>
				<input
					bind:value={agentCommand}
					placeholder="opencode acp — or a JSON object with command, args, env"
				/>
			</label>
			<div class="actions">
				<button
					class="ed-action ed-action--primary"
					onclick={saveAgent}
					disabled={!agentKey.trim() || !agentCommand.trim()}
				>
					Save agent
				</button>
				{#if agentNotice}<span class="t-strip" role="status">{agentNotice}</span>{/if}
			</div>
			{#if agentsError}
				<p class="ed-notice" role="alert">Not saved — the store's agents are unchanged. {agentsError}</p>
			{/if}
		</div>
	</section>

	<p class="t-label">This device</p>
	<section class="ed-rail">
		<label class="field">
			<span class="t-strip">Device label</span>
			<input bind:value={deviceLabel} placeholder="this machine's hostname" />
		</label>
		<div class="actions">
			<button
				class="ed-action ed-action--primary"
				onclick={saveDeviceLabel}
				disabled={savingLabel || !labelDirty}
			>
				{savingLabel ? 'Saving…' : 'Save'}
			</button>
			{#if labelSaved}<span class="t-strip" role="status">saved</span>{/if}
		</div>
		{#if saveLabelError}
			<p class="ed-notice" role="alert">
				Not saved — this device's label is unchanged. {saveLabelError}
			</p>
		{/if}
		<p class="t-strip">
			What home says when a place of work was left on this device and you return from another.
			Blank means the machine's hostname.
		</p>
	</section>

	<p class="t-label">Connection</p>
	<section class="ed-rail">
		<p class="t-strip" role="status">
			{#if temperViews.connected === true}
				connected{temperViews.profileIdentity
					? ` as ${temperViews.profileIdentity.displayName}`
					: ''}
			{:else if temperViews.connected === false}
				not connected{temperViews.connectError ? ` — ${temperViews.connectError}` : ''}
			{:else}
				asking temper…
			{/if}
		</p>
		<div class="actions">
			<a class="t-action" href={placeHref('connection')}>edit the connection…</a>
			{#if temperViews.connected === true}
				<button class="t-action" onclick={signOut} disabled={signingOut}>
					{signingOut ? 'Signing out…' : 'Sign out'}
				</button>
			{/if}
		</div>
		{#if signOutError}
			<p class="ed-notice" role="alert">Not signed out — the grant is still held. {signOutError}</p>
		{/if}
		<p class="t-strip">
			Signing out ends this app's custody of the temper grant on this device; the credential is
			forgotten, not stored.
		</p>
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
	.agent-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.4rem;
		width: 100%;
	}
	.agent-list li {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}
	.agent-name {
		color: var(--tp-text);
	}
	.agent-command {
		flex: 1;
		overflow-wrap: anywhere;
		color: var(--tp-text-muted);
		font-family: var(--tp-font-doing);
	}
	.agent-form {
		display: grid;
		gap: 0.8rem;
		width: 100%;
		padding-top: 0.8rem;
		border-top: 1px solid var(--tp-rule);
	}
	.roster {
		display: grid;
		gap: 0.5rem;
		width: 100%;
	}
	.roster a {
		color: var(--tp-accent);
	}
</style>
