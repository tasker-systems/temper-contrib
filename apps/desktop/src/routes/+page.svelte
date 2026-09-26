<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';

	type ConnectionStatus = { connected: boolean; error: string | null };

	let status = $state<ConnectionStatus | null>(null);
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

	const refreshStatus = () =>
		run(() => invoke<ConnectionStatus>('temper_connection_status'), (v) => (status = v));
	const whoami = () =>
		run(() => invoke<unknown>('temper_whoami'), (v) => (profile = JSON.stringify(v, null, 2)));
	const initializeAgent = () =>
		run(
			() => invoke<unknown>('acp_initialize', { command: agentCommand }),
			(v) => (acpResult = JSON.stringify(v, null, 2))
		);

	refreshStatus();
</script>

<main>
	<h1>temper-desktop</h1>

	<section>
		<h2>temper</h2>
		<p>
			Connection:
			{#if status?.connected}
				<strong>connected</strong>
			{:else if status}
				<strong>not connected</strong>
				{#if status.error}
					— {status.error}
				{/if}
			{:else}
				checking…
			{/if}
		</p>
		<button onclick={whoami} disabled={busy || !status?.connected}>Who am I?</button>
		{#if profile}<pre>{profile}</pre>{/if}
	</section>

	<section>
		<h2>ACP agent</h2>
		<label>
			Command
			<input bind:value={agentCommand} placeholder="opencode acp" />
		</label>
		<button onclick={initializeAgent} disabled={busy || !agentCommand.trim()}>
			Initialize handshake
		</button>
		{#if acpResult}<pre>{acpResult}</pre>{/if}
	</section>

	{#if error}
		<p class="error">{error}</p>
	{/if}
</main>

<style>
	main {
		max-width: 640px;
		margin: 0 auto;
		padding: 2rem 1rem;
		font-family: system-ui, sans-serif;
	}
	h1 {
		font-size: 1.4rem;
	}
	h2 {
		font-size: 1.05rem;
		margin-bottom: 0.5rem;
	}
	section {
		margin-bottom: 2rem;
	}
	label {
		display: block;
		margin-bottom: 0.5rem;
	}
	input {
		width: 100%;
		box-sizing: border-box;
		margin-top: 0.25rem;
		padding: 0.4rem;
	}
	pre {
		background: #f4f4f5;
		padding: 0.75rem;
		border-radius: 6px;
		overflow: auto;
		max-height: 320px;
		font-size: 0.8rem;
	}
	.error {
		color: #b91c1c;
	}
	button {
		padding: 0.4rem 0.9rem;
		cursor: pointer;
	}
	button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>
