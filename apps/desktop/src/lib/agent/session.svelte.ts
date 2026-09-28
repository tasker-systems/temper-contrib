import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { untrack } from 'svelte';
import { stepTitle, tabs } from '$lib/shell/tabs.svelte';
import {
	type AcpUpdate,
	type AskedNotice,
	type AskNotice,
	applyConfigUpdate,
	applyModeUpdate,
	applyNotice,
	applyUpdate,
	type ChatMessage,
	type DeclaredConfigOption,
	type DeclaredOption,
	type DeclaredSelection,
	declaredSelection,
	EMPTY_SELECTION
} from './reducers';

/** What is in view in the person's room, as the agent is shown it: a reference, never the body. */
export type InView = { uri: string; name: string };

/**
 * The active tab's subject as a reference the agent's own temper tools resolve — a `temper:` URI
 * over the resource's decorated ref, named by its title. Places and queries are not resources and
 * are never shared.
 */
export function inViewReference(): InView | null {
	const step = tabs.current(tabs.active);
	if (step.subject.kind !== 'resource') return null;
	return { uri: `temper:${step.ref ?? step.subject.id}`, name: stepTitle(step) };
}

type ConversationInfo = {
	conversationId: string;
	sessionId: string;
	agentInfo: unknown;
	modes?: DeclaredSelection['modes'];
	configOptions?: DeclaredConfigOption[] | null;
};
type AcpEvent = { conversationId: string; sessionId: string; update: AcpUpdate };

/** One configured agent, as the device store holds it: the launch spec
 *  (a command string, or a JSON object with command/args/env) and the
 *  picker's label. The roster is configuration — the desktop hardcodes
 *  none of it. */
export type ConfiguredAgent = { key: string; label: string; command: string };

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
	selection = $state<DeclaredSelection>(EMPTY_SELECTION);
	draft = $state<string>('');
	prompting = $state<boolean>(false);
	starting = $state<boolean>(false);
	error = $state<string>('');
	agents = $state<ConfiguredAgent[]>([]);
	agentKey = $state<string>('');
	workingDir = $state<string>('');
	panelOpen = $state<boolean>(true);
	// The work record's open facts — set when the conversation opens, written when it closes.
	openedAt = $state<string>('');
	recordKey = $state<string>('');
	/** The last reference the agent was shown in this conversation; a new conversation forgets it. */
	lastReferenceUri = $state<string | null>(null);

	private unlisten: UnlistenFn | null = null;
	private unlistenAsk: UnlistenFn | null = null;
	private initialised = false;

	init(): void {
		if (this.initialised) return;
		this.initialised = true;
		this.restorePanel();
		this.loadDefaults();
		this.loadAgents();
		this.listenOnce();
	}

	/** The picker's roster is the device store's configured agents — read
	 *  once at init, read again when the settings room changes it. A store
	 *  that cannot be read leaves the roster empty and says nothing: an
	 *  empty picker is honest, a hardcoded fallback is not. */
	async loadAgents(): Promise<void> {
		try {
			const settings = await invoke<{
				agents?: Record<string, { label?: string | null; command?: string | null }>;
			}>('settings_get');
			const roster: ConfiguredAgent[] = Object.entries(settings.agents ?? {})
				.filter(([, a]) => typeof a.command === 'string' && a.command.trim() !== '')
				.map(([key, a]) => ({
					key,
					label: a.label ?? key,
					command: a.command as string
				}));
			this.agents = roster;
			if (!roster.some((a) => a.key === this.agentKey)) {
				this.agentKey = roster[0]?.key ?? '';
			}
		} catch {
			// The store is unreachable; the roster stays empty and says nothing.
		}
	}

	selectAgent(key: string): void {
		this.agentKey = key;
	}

	agentLabel(): string {
		return this.agents.find((a) => a.key === this.agentKey)?.label ?? this.agentKey;
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
			// Declared-change shapes land on the selection, not the transcript:
			// the two are different state, each with its own reducer.
			const update = event.payload.update;
			if (update.sessionUpdate === 'current_mode_update') {
				const modeId = (update as { currentModeId?: unknown }).currentModeId;
				if (typeof modeId === 'string') {
					untrack(() => applyModeUpdate(this.selection, modeId));
				}
				return;
			}
			if (update.sessionUpdate === 'config_option_update') {
				const options = (update as { configOptions?: unknown }).configOptions;
				if (Array.isArray(options)) {
					untrack(() => applyConfigUpdate(this.selection, options as DeclaredConfigOption[]));
				}
				return;
			}
			applyUpdate(this.messages, update);
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
		const agent = this.agents.find((a) => a.key === this.agentKey) ?? this.agents[0];
		if (!agent) {
			this.error = 'No agent is configured — add one in the settings room.';
			return;
		}
		this.starting = true;
		this.error = '';
		try {
			const info = await invoke<ConversationInfo>('acp_start', {
				command: agent.command,
				cwd: this.workingDir
			});
			this.conversation = info;
			this.messages = [];
			this.asks = [];
			this.lastReferenceUri = null;
			// The declared selection is established at conversation start from
			// what `session/new` declared — never inherited from how the room
			// was entered, never guessed for an agent that declares nothing.
			this.selection = declaredSelection(info);
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
		// The room in view goes with the first prompt, then only when it has changed since the last
		// prompt that carried one. The transcript records exactly what went with the text.
		const inView = inViewReference();
		const reference = inView && inView.uri !== this.lastReferenceUri ? inView : null;
		const previous = this.lastReferenceUri;
		if (reference) this.lastReferenceUri = reference.uri;
		this.messages.push(
			reference ? { role: 'user', text, with: reference.name } : { role: 'user', text }
		);
		this.prompting = true;
		this.error = '';
		try {
			await invoke<string>('acp_prompt', {
				conversationId: this.conversation.conversationId,
				text,
				reference
			});
		} catch (e) {
			this.error = String(e);
			// Nothing reached the agent: the next prompt shares the room again.
			if (reference) this.lastReferenceUri = previous;
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

	/** Changes the session's mode. The id is the agent's own — one of what
	 *  it declared; the agent's own error, if the id is not one of them,
	 *  is relayed as the error. The declared change lands as a
	 *  `current_mode_update` notification, which the listener applies. */
	async setMode(modeId: string): Promise<void> {
		if (!this.conversation) return;
		try {
			await invoke('acp_set_mode', {
				conversationId: this.conversation.conversationId,
				modeId
			});
		} catch (e) {
			this.error = String(e);
		}
	}

	/** Changes one declared configuration option's value. The value shape is
	 *  the agent's own (a value id for a select, a boolean for a toggle);
	 *  the updated declared set arrives as a `config_option_update`. */
	async setConfigOption(configId: string, value: string | boolean): Promise<void> {
		if (!this.conversation) return;
		try {
			await invoke('acp_set_config_option', {
				conversationId: this.conversation.conversationId,
				configId,
				value: typeof value === 'boolean' ? { type: 'boolean', value } : { type: 'value_id', value }
			});
		} catch (e) {
			this.error = String(e);
		}
	}

	async close(): Promise<void> {
		if (!this.conversation) return;
		const id = this.conversation.conversationId;
		// Captured before the state clears: the record names the conversation that was.
		const label = this.agentLabel();
		const command = this.agents.find((a) => a.key === this.agentKey)?.command ?? this.agentKey;
		const dir = this.workingDir;
		const opened = this.openedAt;
		const key = this.recordKey;
		this.conversation = null;
		this.messages = [];
		this.asks = [];
		this.selection = EMPTY_SELECTION;
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
