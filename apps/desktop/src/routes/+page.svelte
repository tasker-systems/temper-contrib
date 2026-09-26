<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { untrack } from 'svelte';
	import RegionState from '$lib/components/RegionState.svelte';

	type ConnectionStatus = { connected: boolean; error: string | null };
	type ConversationInfo = { conversationId: string; sessionId: string; agentInfo: unknown };
	type AcpUpdate = {
		sessionUpdate?: string;
		content?: { type?: string; text?: string };
		title?: string;
		toolCallId?: string;
		status?: string;
	};
	type AcpEvent = { conversationId: string; sessionId: string; update: AcpUpdate };
	type ChatMessage = { role: 'user' | 'assistant' | 'system'; text: string };

	const AGENTS = [
		{ label: 'opencode', command: 'opencode acp' },
		{ label: 'claude code', command: 'npx -y @zed-industries/claude-code-acp' }
	];

	let status = $state<ConnectionStatus | null>(null);
	let statusFailed = $state<string>('');
	let profile = $state<string>('');
	let error = $state<string>('');
	let busy = $state<boolean>(false);

	let agentCommand = $state<string>(AGENTS[0].command);
	let workingDir = $state<string>('');
	let conversation = $state<ConversationInfo | null>(null);
	let messages = $state<ChatMessage[]>([]);
	let draft = $state<string>('');
	let prompting = $state<boolean>(false);
	let starting = $state<boolean>(false);
	let unlisten: UnlistenFn | null = null;

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

	async function refreshStatus(): Promise<void> {
		try {
			status = await invoke<ConnectionStatus>('temper_connection_status');
		} catch (e) {
			statusFailed = String(e);
		}
	}
	const whoami = () =>
		run(() => invoke<unknown>('temper_whoami'), (v) => (profile = JSON.stringify(v, null, 2)));

	$effect(() => {
		listen<AcpEvent>('acp-update', (event) => {
			const current = untrack(() => conversation);
			if (!current || event.payload.conversationId !== current.conversationId) return;
			applyUpdate(event.payload.update);
		}).then((u) => {
			unlisten = u;
		});
		return () => unlisten?.();
	});

	function chunkText(update: AcpUpdate): string | null {
		const content = update.content;
		return update.sessionUpdate === 'agent_message_chunk' &&
			content?.type === 'text' &&
			typeof content.text === 'string'
			? content.text
			: null;
	}

	function applyUpdate(update: AcpUpdate): void {
		const text = chunkText(update);
		if (text !== null) {
			const last = messages[messages.length - 1];
			if (last && last.role === 'assistant') {
				last.text += text;
			} else {
				messages.push({ role: 'assistant', text });
			}
			return;
		}
		if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
			const label = update.title ?? update.toolCallId ?? 'tool';
			messages.push({
				role: 'system',
				text: `tool · ${label}${update.status ? ` · ${update.status}` : ''}`
			});
		}
	}

	function agentLabel(): string {
		return AGENTS.find((a) => a.command === agentCommand)?.label ?? agentCommand;
	}

	async function startConversation(): Promise<void> {
		if (!workingDir.trim()) {
			error = 'A working directory is required — agents treat it as their project root.';
			return;
		}
		starting = true;
		error = '';
		try {
			const info = await invoke<ConversationInfo>('acp_start', {
				command: agentCommand,
				cwd: workingDir
			});
			conversation = info;
			messages = [];
		} catch (e) {
			error = String(e);
		} finally {
			starting = false;
		}
	}

	async function sendPrompt(): Promise<void> {
		const text = draft.trim();
		if (!text || !conversation || prompting) return;
		draft = '';
		messages.push({ role: 'user', text });
		prompting = true;
		error = '';
		try {
			await invoke<string>('acp_prompt', {
				conversationId: conversation.conversationId,
				text
			});
		} catch (e) {
			error = String(e);
		} finally {
			prompting = false;
		}
	}

	async function closeConversation(): Promise<void> {
		if (!conversation) return;
		const id = conversation.conversationId;
		conversation = null;
		messages = [];
		try {
			await invoke('acp_close', { conversationId: id });
		} catch {
			// the conversation is already gone client-side; a dead agent cleans up server-side
		}
	}

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

	<p class="t-label">ACP chat</p>
	<section class="ed-rail">
		{#if !conversation}
			<div class="agents" role="group" aria-label="Agent">
				<span class="t-strip">Agent</span>
				{#each AGENTS as agent (agent.command)}
					<button
						class="t-action"
						aria-pressed={agentCommand === agent.command}
						onclick={() => (agentCommand = agent.command)}
					>
						{agent.label}
					</button>
				{/each}
			</div>
			<label class="field">
				<span class="t-strip">Working directory</span>
				<input bind:value={workingDir} placeholder="/path/to/project" />
			</label>
			<button
				class="ed-action ed-action--primary"
				onclick={startConversation}
				disabled={starting || !agentCommand.trim()}
			>
				{starting ? `Starting ${agentLabel()}…` : 'Start conversation'}
			</button>
		{:else}
			<p class="t-strip">
				{agentLabel()} <span aria-hidden="true">·</span> session <span class="ed-strip-em">{conversation.sessionId}</span>
			</p>
			<div class="transcript">
				{#each messages as message, i (i)}
					<p class={message.role}>{message.text}</p>
				{/each}
				{#if prompting}
					<p class="pending" role="status"><span aria-hidden="true">◌</span> {agentLabel()} is responding…</p>
				{/if}
			</div>
			<form
				class="composer"
				onsubmit={(event) => {
					event.preventDefault();
					sendPrompt();
				}}
			>
				<input
					bind:value={draft}
					placeholder={prompting ? 'agent is responding…' : 'type a message'}
				/>
				<button class="ed-action ed-action--primary" type="submit" disabled={prompting || !draft.trim()}>
					Send
				</button>
			</form>
			<button class="ed-action ed-action--ghost" onclick={closeConversation}>End conversation</button>
		{/if}
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
	.agents {
		display: flex;
		align-items: baseline;
		gap: 1rem;
	}
	.agents :global(button[aria-pressed='true']) {
		color: var(--tp-text);
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
	.transcript {
		box-sizing: border-box;
		width: 100%;
		max-height: 360px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.9rem 1rem;
		background: var(--tp-surface);
		border: 1px solid var(--tp-rule);
	}
	.transcript p {
		margin: 0;
		white-space: pre-wrap;
	}
	.transcript .user {
		font: 500 0.9rem/1.6 var(--tp-font-ui);
		color: var(--tp-text);
	}
	.transcript .assistant {
		font: 1rem/1.7 var(--tp-font-reading);
		color: var(--tp-text-muted);
	}
	.transcript .system {
		font: 0.68rem var(--tp-font-doing);
		letter-spacing: 0.04em;
		color: var(--tp-text-subtle);
	}
	.pending {
		font: italic 0.85rem var(--tp-font-reading);
		color: var(--tp-region-arriving);
	}
	.composer {
		display: flex;
		gap: 0.8rem;
		align-items: center;
		width: 100%;
	}
	.composer input {
		flex: 1;
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
