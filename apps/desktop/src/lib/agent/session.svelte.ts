import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { untrack } from 'svelte';
import {
	type AcpUpdate,
	type AskedNotice,
	type AskNotice,
	applyNotice,
	applyUpdate,
	type ChatMessage,
	type DeclaredOption
} from './reducers';

type ConversationInfo = { conversationId: string; sessionId: string; agentInfo: unknown };
type AcpEvent = { conversationId: string; sessionId: string; update: AcpUpdate };

export const AGENTS = [
	{ label: 'opencode', command: 'opencode acp' },
	{ label: 'claude code', command: 'npx -y @zed-industries/claude-code-acp' }
];

const STORE_KEY = 'temper-agent-panel-v1';

/**
 * The engagement, as one module-level store: the conversation, its
 * transcript, its asks, and the surface a person answers them through. The
 * store — not any component — owns the listeners, so a route change or a
 * closed panel never stops the conversation, never drops streamed output,
 * and never cancels a parked ask. Closing the panel hides the view; the
 * store carries on.
 */
class AgentSession {
	conversation = $state<ConversationInfo | null>(null);
	messages = $state<ChatMessage[]>([]);
	asks = $state<AskedNotice[]>([]);
	draft = $state<string>('');
	prompting = $state<boolean>(false);
	starting = $state<boolean>(false);
	error = $state<string>('');
	agentCommand = $state<string>(AGENTS[0].command);
	workingDir = $state<string>('');
	panelOpen = $state<boolean>(true);
	// The work record's open facts — set when the conversation opens, written when it closes.
	openedAt = $state<string>('');
	recordKey = $state<string>('');

	private unlisten: UnlistenFn | null = null;
	private unlistenAsk: UnlistenFn | null = null;
	private initialised = false;

	init(): void {
		if (this.initialised) return;
		this.initialised = true;
		this.restorePanel();
		this.loadDefaults();
		this.listenOnce();
	}

	/** The panel's open/closed state is a device fact: a versioned key, try/catch — a store
	 *  that cannot be written does not fail the engagement it decorates. */
	private restorePanel(): void {
		try {
			const raw = localStorage.getItem(STORE_KEY);
			if (raw !== null) this.panelOpen = raw === 'true';
		} catch {
			// Unavailable storage keeps the default; nothing else depends on it.
		}
	}

	setPanelOpen(open: boolean): void {
		this.panelOpen = open;
		try {
			localStorage.setItem(STORE_KEY, String(open));
		} catch {
			// The preference is best-effort; the panel itself is unaffected.
		}
	}

	private loadDefaults(): void {
		invoke<{ workingDir?: string | null }>('settings_get')
			.then((settings) => {
				this.workingDir = settings.workingDir ?? this.workingDir;
			})
			.catch(() => {
				// The store is unreachable; the input stays empty and declaring still works.
			});
	}

	private listenOnce(): void {
		listen<AcpEvent>('acp-update', (event) => {
			const current = untrack(() => this.conversation);
			if (!current || event.payload.conversationId !== current.conversationId) return;
			applyUpdate(this.messages, event.payload.update);
		}).then((u) => {
			this.unlisten = u;
		});
		listen<AskNotice>('acp-ask', (event) => {
			const current = untrack(() => this.conversation);
			if (!current || event.payload.conversationId !== current.conversationId) return;
			applyNotice(this.messages, this.asks, event.payload);
		}).then((u) => {
			this.unlistenAsk = u;
		});
	}

	agentLabel(): string {
		return AGENTS.find((a) => a.command === this.agentCommand)?.label ?? this.agentCommand;
	}

	/** The declared-at-start directory is also the preference: a store that cannot be written
	 *  does not fail a conversation that has already begun. */
	private rememberWorkingDir(): void {
		invoke('settings_set_working_dir', { dir: this.workingDir.trim() }).catch(() => {});
	}

	async start(): Promise<void> {
		if (!this.workingDir.trim()) {
			this.error = 'A working directory is required — agents treat it as their project root.';
			return;
		}
		this.starting = true;
		this.error = '';
		try {
			const info = await invoke<ConversationInfo>('acp_start', {
				command: this.agentCommand,
				cwd: this.workingDir
			});
			this.conversation = info;
			this.messages = [];
			this.asks = [];
			this.rememberWorkingDir();
			this.openedAt = new Date().toISOString();
			this.recordKey = crypto.randomUUID();
		} catch (e) {
			this.error = String(e);
		} finally {
			this.starting = false;
		}
	}

	async send(): Promise<void> {
		const text = this.draft.trim();
		if (!text || !this.conversation || this.prompting) return;
		this.draft = '';
		this.messages.push({ role: 'user', text });
		this.prompting = true;
		this.error = '';
		try {
			await invoke<string>('acp_prompt', {
				conversationId: this.conversation.conversationId,
				text
			});
		} catch (e) {
			this.error = String(e);
		} finally {
			this.prompting = false;
		}
	}

	async answer(ask: AskedNotice, option: DeclaredOption): Promise<void> {
		if (!this.conversation) return;
		try {
			await invoke('acp_answer_permission', {
				conversationId: this.conversation.conversationId,
				askId: ask.askId,
				optionId: option.optionId
			});
		} catch {
			// The ask is already resolved elsewhere (the room closed); its
			// resolution event carries the outcome.
		}
	}

	async close(): Promise<void> {
		if (!this.conversation) return;
		const id = this.conversation.conversationId;
		// Captured before the state clears: the record names the conversation that was.
		const label = this.agentLabel();
		const command = this.agentCommand;
		const dir = this.workingDir;
		const opened = this.openedAt;
		const key = this.recordKey;
		this.conversation = null;
		this.messages = [];
		this.asks = [];
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
			this.error = `the work record was not written — ${String(e)}`;
		}
	}
}

/** The engagement, as a singleton. `init()` is idempotent: the layout calls
 *  it, and so may any other surface, without doubling the listeners. */
export const agentSession = new AgentSession();
