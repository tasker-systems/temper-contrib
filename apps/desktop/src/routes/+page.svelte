<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { untrack } from 'svelte';
	import RegionState from '$lib/components/RegionState.svelte';
	import TemperViews from '$lib/components/TemperViews.svelte';
	import Transcript, { type ChatMessage } from '$lib/components/Transcript.svelte';

	type ConversationInfo = { conversationId: string; sessionId: string; agentInfo: unknown };
	type AcpUpdate = {
		sessionUpdate?: string;
		content?: { type?: string; text?: string };
		title?: string;
		toolCallId?: string;
		status?: string;
	};
	type AcpEvent = { conversationId: string; sessionId: string; update: AcpUpdate };

	const AGENTS = [
		{ label: 'opencode', command: 'opencode acp' },
		{ label: 'claude code', command: 'npx -y @zed-industries/claude-code-acp' }
	];

	let error = $state<string>('');

	let agentCommand = $state<string>(AGENTS[0].command);
	let workingDir = $state<string>('');
	let conversation = $state<ConversationInfo | null>(null);
	let messages = $state<ChatMessage[]>([]);
	let draft = $state<string>('');
	let prompting = $state<boolean>(false);
	let starting = $state<boolean>(false);
	let unlisten: UnlistenFn | null = null;
	// The work record's open facts — set when the conversation opens, written when it closes.
	let openedAt = $state<string>('');
	let recordKey = $state<string>('');

	async function loadDefaults(): Promise<void> {
		try {
			const settings = await invoke<{ workingDir?: string | null }>('settings_get');
			workingDir = settings.workingDir ?? workingDir;
		} catch {
			// The store is unreachable; the input stays empty and declaring still works.
		}
	}

	/** The declared-at-start directory is also the preference: a store that cannot be written
	 *  does not fail a conversation that has already begun. */
	function rememberWorkingDir(): void {
		invoke('settings_set_working_dir', { dir: workingDir.trim() }).catch(() => {});
	}

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
			// One transcript line per tool call: updates refresh the existing
			// entry rather than appending a new line per notification.
			const id = typeof update.toolCallId === 'string' ? update.toolCallId : null;
			let entry = id
				? [...messages].reverse().find((m) => m.role === 'system' && m.toolCallId === id)
				: undefined;
			if (!entry) {
				entry = { role: 'system', text: update.title ?? id ?? 'tool', toolCallId: id ?? undefined };
				messages.push(entry);
			} else if (update.title) {
				entry.text = update.title;
			}
			if (update.status) entry.status = update.status;
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
		rememberWorkingDir();
		openedAt = new Date().toISOString();
		recordKey = crypto.randomUUID();
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
		// Captured before the state clears: the record names the conversation that was.
		const label = agentLabel();
		const command = agentCommand;
		const dir = workingDir;
		const opened = openedAt;
		const key = recordKey;
		conversation = null;
		messages = [];
		try {
			await invoke('acp_close', { conversationId: id });
		} catch {
			// the conversation is already gone client-side; a dead agent cleans up server-side
		}
		try {
			await invoke('temper_write_work_record', {
				facts: {
					agentLabel: label,
					agentCommand: command,
					workingDir: dir,
					openedAt: opened,
					closedAt: new Date().toISOString()
				},
				idempotencyKey: key
			});
		} catch (e) {
			// The close stands; only the record is missing, and it is named.
			error = `the work record was not written — ${String(e)}`;
		}
	}

	loadDefaults();
</script>

<main class="page">
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
			<Transcript {messages} pending={prompting ? agentLabel() : null} />
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

	<TemperViews />

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
	.composer {
		display: flex;
		gap: 0.8rem;
		align-items: center;
		width: 100%;
	}
	.composer input {
		flex: 1;
	}
</style>
