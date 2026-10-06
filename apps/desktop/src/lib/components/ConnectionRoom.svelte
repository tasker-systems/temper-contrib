<script lang="ts">
	/**
	 * The connection room: the desktop's `temper init` equivalent — the choice
	 * `temper init` asks (hosted temperkb.io, a self-hosted instance with its
	 * own Auth0 tenant or Okta authorization server, or a native-SAML
	 * instance's own Authorization Server), the inputs each shape needs, and
	 * the current connection's state as the machine's config resolves it.
	 *
	 * On a fresh machine — the machine's config does not exist — the vault
	 * path is shown and editable, and apply establishes the whole file at
	 * init parity. Apply calls `temper_connection_apply`; a refusal renders
	 * as one line. The first run chains: apply, then sign-in, then the
	 * person-context setup room. An existing machine with a config enters at
	 * sign-in.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import RegionState from '$lib/components/RegionState.svelte';
	import { temperViews } from '$lib/temper-views.svelte';
	import type { TabHandle } from '$lib/shell/lenses';

	/** The host's open answer — the first-run chain's way into the setup room. */
	let { tab }: { tab?: TabHandle } = $props();

	type Provider = {
		name: string;
		authorizeUrl: string;
		tokenUrl: string;
		clientId: string;
		audience: string;
		callbackUrl: string;
		scopes: string[];
		desktopClientId: string | null;
	};

	type Gather = {
		configExists: boolean;
		defaultVaultPath: string | null;
		choice: string | null;
		provider: Provider | null;
		apiUrl: string | null;
		signInRefusal: string | null;
	};

	/** The four shapes the room offers: init's instance selector, flattened. */
	type Shape = 'hosted' | 'self-hosted-auth0' | 'self-hosted-okta' | 'temper-as';

	const SHAPES: { value: Shape; words: string }[] = [
		{ value: 'hosted', words: 'hosted (temperkb.io cloud sync)' },
		{ value: 'self-hosted-auth0', words: 'self-hosted (your own instance + Auth0 tenant)' },
		{ value: 'self-hosted-okta', words: 'self-hosted (your own instance + Okta)' },
		{ value: 'temper-as', words: 'temper-as (the instance’s own Authorization Server)' }
	];

	let view = $state<Gather | null>(null);
	let viewError = $state('');

	let shape = $state<Shape>('hosted');
	let instanceUrl = $state('');
	let authDomain = $state('');
	let clientId = $state('');
	let audience = $state('');
	let authServerId = $state('');
	let vaultPath = $state('');

	let applying = $state(false);
	let applyError = $state('');
	let establishedVaultPath = $state('');
	let signingIn = $state(false);
	let signInError = $state('');

	/** Whether this room's machine was fresh when the room opened — the first-run chain's arm. */
	let openedFresh = $state(false);

	const fresh = $derived(view !== null && !view.configExists);
	const canSignIn = $derived(view?.provider !== null && view?.provider !== undefined);
	const refusal = $derived(view?.signInRefusal ?? '');

	async function load(): Promise<Gather> {
		return invoke<Gather>('temper_connection_gather');
	}

	/** The shape a resolved choice reads as; Okta shows in its authorize URL's shape. */
	function shapeOf(resolved: string | null, provider: Provider | null): Shape {
		if (resolved === 'temper-as') return 'temper-as';
		if (resolved === 'self-hosted') {
			return provider?.authorizeUrl.includes('/oauth2/') ? 'self-hosted-okta' : 'self-hosted-auth0';
		}
		return 'hosted';
	}

	onMount(async () => {
		try {
			const gathered = await load();
			view = gathered;
			openedFresh = !gathered.configExists;
			shape = shapeOf(gathered.choice, gathered.provider);
			vaultPath = gathered.defaultVaultPath ?? '';
		} catch (e) {
			viewError = String(e);
		}
	});

	function request(): Record<string, string> {
		const fields: Record<string, string> = {};
		if (fresh && vaultPath.trim()) fields.vaultPath = vaultPath.trim();
		switch (shape) {
			case 'hosted':
				fields.choice = 'hosted';
				break;
			case 'temper-as':
				Object.assign(fields, { choice: 'temper-as', instanceUrl: instanceUrl.trim() });
				break;
			case 'self-hosted-auth0':
				Object.assign(fields, {
					choice: 'self-hosted',
					instanceUrl: instanceUrl.trim(),
					authDomain: authDomain.trim(),
					clientId: clientId.trim(),
					audience: audience.trim(),
					idp: 'auth0'
				});
				break;
			case 'self-hosted-okta':
				Object.assign(fields, {
					choice: 'self-hosted',
					instanceUrl: instanceUrl.trim(),
					authDomain: authDomain.trim(),
					clientId: clientId.trim(),
					audience: audience.trim(),
					idp: 'okta',
					authServerId: authServerId.trim()
				});
				break;
		}
		return fields;
	}

	async function apply(): Promise<void> {
		applying = true;
		applyError = '';
		establishedVaultPath = '';
		try {
			const reply = (await invoke('temper_connection_apply', { request: request() })) as Gather & {
				establishedVaultPath: string | null;
			};
			view = reply;
			if (reply.establishedVaultPath) establishedVaultPath = reply.establishedVaultPath;
			// The first-run chain: a room entered on a machine that had no
			// config carries the person straight into sign-in once its apply
			// establishes. An existing machine enters at sign-in — its own
			// button, never a surprise browser.
			if (openedFresh && reply.provider && !reply.signInRefusal) await signIn();
		} catch (e) {
			applyError = String(e);
		} finally {
			applying = false;
		}
	}

	async function signIn(): Promise<void> {
		signingIn = true;
		signInError = '';
		try {
			await invoke('temper_signin');
		} catch (e) {
			signInError = String(e);
		} finally {
			signingIn = false;
		}
		// The re-query decides what is true: the grant can be in the desktop's
		// custody even when the sign-in command answered an error (a profile
		// read failing after the token landed). The connection is asked again
		// before anything is said, and a succeeded sign-in is never called
		// failed.
		await temperViews.refreshProfile();
		try {
			view = await load();
		} catch {
			// the state in hand stands; the corner carries the re-queried facts
		}
		if (!signInError && temperViews.connected === true && openedFresh) {
			// The first-run chain's last link: the person-context setup room,
			// through the one door, in this tab.
			tab?.open({ kind: 'place', place: 'setup' }, 'here');
		}
	}
</script>

<div class="page">
	<div class="ed-strip">
		<span>connection</span><span class="ed-strip-sep">·</span>
		<span>how this app reaches temper</span>
	</div>

	<h1 class="t-h2">The <em>connection</em> room</h1>

	{#if viewError}
		<RegionState state="failed" label="the connection" detail={viewError} />
	{/if}

	<p class="t-body">
		The app reaches temper the same way the temper CLI does: one provider entry in the machine's
		config, the desktop's own OAuth client. Choose the instance; temper is asked before anything
		is written.
	</p>

	{#if view}
		<p class="t-label">Current connection</p>
		<section class="ed-rail">
			{#if view.provider}
				<p class="t-strip" role="status">
					{#if view.choice}{view.choice}{:else}{view.provider.name}{/if}
					— {view.provider.audience}{#if view.apiUrl} · {view.apiUrl}{/if}
				</p>
			{:else}
				<p class="t-strip" role="status">
					{view.configExists
						? 'temper says nothing resolves on this machine — choose below.'
						: 'this machine carries no temper config yet — establish one below.'}
				</p>
			{/if}
		</section>
	{/if}

	<p class="t-label">Instance</p>
	<section class="ed-rail">
		<div class="choices" role="radiogroup" aria-label="Instance">
			{#each SHAPES as option (option.value)}
				<label class="choice">
					<input type="radio" bind:group={shape} value={option.value} disabled={applying} />
					<span class="t-strip">{option.words}</span>
				</label>
			{/each}
		</div>

		{#if shape !== 'hosted'}
			<label class="field">
				<span class="t-strip">Instance base URL</span>
				<input bind:value={instanceUrl} placeholder="https://temper.acme.com" />
			</label>
			<label class="field">
				<span class="t-strip">{shape === 'self-hosted-okta' ? 'Okta org domain' : 'Auth0 tenant domain'}</span>
				<input bind:value={authDomain} placeholder={shape === 'self-hosted-okta' ? 'acme.okta.com' : 'acme.us.auth0.com'} />
			</label>
			{#if shape === 'self-hosted-okta'}
				<label class="field">
					<span class="t-strip">Okta authorization server ID</span>
					<input bind:value={authServerId} placeholder="aus1a2b3c" />
				</label>
			{/if}
			<label class="field">
				<span class="t-strip">CLI application client_id</span>
				<input bind:value={clientId} placeholder="the deployment's registered CLI client" />
			</label>
			<label class="field">
				<span class="t-strip">API audience</span>
				<input bind:value={audience} placeholder="https://temper.acme.com/api" />
			</label>
		{/if}

		{#if fresh}
			<label class="field">
				<span class="t-strip">Vault path — created with the connection</span>
				<input bind:value={vaultPath} placeholder="~/Documents/temper-vault" />
			</label>
		{/if}

		<div class="actions">
			<button class="ed-action ed-action--primary" onclick={apply} disabled={applying}>
				{applying ? 'Applying…' : 'Apply'}
			</button>
			{#if canSignIn && !fresh}
				<button class="ed-action" onclick={signIn} disabled={signingIn || Boolean(refusal)}>
					{signingIn ? 'Waiting for your browser…' : 'Sign in'}
				</button>
			{/if}
		</div>
		{#if signingIn}
			<p class="t-strip" role="status">
				temper opened your browser to ask for the grant — this can take up to two minutes.
			</p>
		{/if}
		{#if establishedVaultPath}
			<p class="t-strip" role="status">
				established the vault at {establishedVaultPath} and wrote the connection.
			</p>
		{/if}
		{#if refusal}
			<p class="ed-notice" role="alert">{refusal}</p>
		{:else if applyError}
			<p class="ed-notice" role="alert">Not applied — the connection is unchanged. {applyError}</p>
		{:else if signInError && temperViews.connected !== true}
			<p class="ed-notice" role="alert">Not signed in — temper is unchanged. {signInError}</p>
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
	.choices {
		display: grid;
		gap: 0.4rem;
		width: 100%;
	}
	.choice {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
		cursor: pointer;
	}
	.choice:hover {
		border-color: var(--tp-accent-line);
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
	.choice input {
		width: auto;
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
