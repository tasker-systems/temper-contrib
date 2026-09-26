<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { untrack } from 'svelte';

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

	const refreshStatus = () =>
		run(() => invoke<ConnectionStatus>('temper_connection_status'), (v) => (status = v));
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
		<h2>ACP chat</h2>
		{#if !conversation}
			<p>Agent</p>
			<div class="agents">
				{#each AGENTS as agent (agent.command)}
					<button
						class:active={agentCommand === agent.command}
						onclick={() => (agentCommand = agent.command)}
					>
						{agent.label}
					</button>
				{/each}
			</div>
			<label>
				Working directory
				<input bind:value={workingDir} placeholder="/path/to/project" />
			</label>
			<button onclick={startConversation} disabled={starting || !agentCommand.trim()}>
				{starting ? `Starting ${agentLabel()}…` : 'Start conversation'}
			</button>
		{:else}
			<p class="session">
				{agentLabel()} · session <code>{conversation.sessionId}</code>
			</p>
			<div class="transcript">
				{#each messages as message, i (i)}
					<p class={message.role}>{message.text}</p>
				{/each}
				{#if prompting}
					<p class="pending">…</p>
				{/if}
			</div>
			<form
				onsubmit={(event) => {
					event.preventDefault();
					sendPrompt();
				}}
			>
				<input
					bind:value={draft}
					placeholder={prompting ? 'agent is responding…' : 'type a message'}
				/>
				<button type="submit" disabled={prompting || !draft.trim()}>Send</button>
			</form>
			<button class="close" onclick={closeConversation}>End conversation</button>
		{/if}
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
		margin: 0.75rem 0 0.5rem;
	}
	input {
		width: 100%;
		box-sizing: border-box;
		margin-top: 0.25rem;
		padding: 0.4rem;
	}
	.agents {
		display: flex;
		gap: 0.5rem;
	}
	.agents button.active {
		font-weight: 700;
		outline: 2px solid #2563eb;
	}
	.session {
		color: #52525b;
		font-size: 0.85rem;
	}
	.transcript {
		border: 1px solid #e4e4e7;
		border-radius: 6px;
		padding: 0.75rem;
		max-height: 360px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}
	.transcript p {
		margin: 0;
		white-space: pre-wrap;
	}
	.transcript .user {
		font-weight: 600;
	}
	.transcript .system {
		color: #71717a;
		font-size: 0.8rem;
	}
	.pending {
		color: #a1a1aa;
	}
	form {
		display: flex;
		gap: 0.5rem;
	}
	form input {
		flex: 1;
		margin-top: 0;
	}
	.close {
		margin-top: 0.5rem;
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
