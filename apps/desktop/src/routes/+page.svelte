<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import RegionState from '$lib/components/RegionState.svelte';

	type ConnectionStatus = { connected: boolean; error: string | null };

	let status = $state<ConnectionStatus | null>(null);
	let statusFailed = $state<string>('');
	let profile = $state<string>('');
	let error = $state<string>('');
	let agentCommand = $state<string>('opencode acp');
	let acpResult = $state<string>('');
	let busy = $state<boolean>(false);

	async function run<T>(action: () => Promise<T>, onOk: (v: T) => void): Promise<void> {
		busy = true;
		error = '';
		try {
			onOk(await action());
		} catch (e) {
			error = String(e);
		} finally {
			busy = false;
		}
	}

	async function refreshStatus() {
		try {
			status = await invoke<ConnectionStatus>('temper_connection_status');
		} catch (e) {
			statusFailed = String(e);
		}
	}
	const whoami = () =>
		run(() => invoke<unknown>('temper_whoami'), (v) => (profile = JSON.stringify(v, null, 2)));
	const initializeAgent = () =>
		run(
			() => invoke<unknown>('acp_initialize', { command: agentCommand }),
			(v) => (acpResult = JSON.stringify(v, null, 2))
		);

	refreshStatus();
</script>

<main class="page">
	<p class="t-label">temper</p>
	<section class="ed-rail">
		{#if statusFailed}
			<RegionState state="failed" label="connection status" detail={statusFailed} />
		{:else if status === null}
			<RegionState state="arriving" label="connection status" />
		{:else if status.connected}
			<p class="state">Connected with this machine's temper credentials.</p>
		{:else}
			<p class="state">Not connected{#if status.error} — {status.error}{/if}.</p>
		{/if}
		<button class="ed-action ed-action--primary" onclick={whoami} disabled={busy || !status?.connected}>
			Who am I?
		</button>
		{#if profile}<pre class="t-code">{profile}</pre>{/if}
	</section>

	<p class="t-label">ACP agent</p>
	<section class="ed-rail">
		<label class="field">
			<span class="t-strip">Command</span>
			<input bind:value={agentCommand} placeholder="opencode acp" />
		</label>
		<button class="ed-action ed-action--primary" onclick={initializeAgent} disabled={busy || !agentCommand.trim()}>
			Initialize handshake
		</button>
		{#if acpResult}<pre class="t-code">{acpResult}</pre>{/if}
	</section>

	{#if error}
		<RegionState state="failed" label="the last request" detail={error} />
	{/if}
</main>

<style>
	.page {
		max-width: 44rem;
		margin: 0 auto;
		padding: 2.5rem 1.5rem 4rem;
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
	.state {
		margin: 0;
		font: 1rem/1.7 var(--tp-font-reading);
		color: var(--tp-text-muted);
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
	pre {
		width: 100%;
		box-sizing: border-box;
		margin: 0;
		padding: 0.8rem 1rem;
		max-height: 320px;
		overflow: auto;
		background: var(--tp-surface);
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-chip);
	}
</style>
