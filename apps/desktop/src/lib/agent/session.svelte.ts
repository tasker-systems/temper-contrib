import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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
 * What a session is started for (ruling B): a context the person works in, or an active goal.
 * The scope goes to the agent with the first prompt, and the work record links it — the record
 * itself lives in the person's context whatever the scope.
 */
export type SessionScope = { kind: 'context' | 'goal'; ref: string; name: string };

/** The scope as the agent is shown it: a reference its own temper tools resolve. */
export function scopeReference(scope: SessionScope): InView {
	return { uri: `temper:${scope.ref}`, name: `${scope.kind} ${scope.name}` };
}

const SCOPE_STORE = 'temper-start-scope-v1';

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
	/** Whether the conversation's presentation surface rides with the session —
	 *  or why not. `unsupported` names the agent's own lack (no MCP HTTP
	 *  support); the agent panel renders the distinction in the presented-views
	 *  surface work. */
	presentations?: { state: 'available' } | { state: 'unsupported'; reason: string };
};
type AcpEvent = { conversationId: string; sessionId: string; update: AcpUpdate };

/** One configured agent, as the device store holds it: the launch spec
 *  (a command string, or a JSON object with command/args/env) and the
 *  picker's label. The roster is configuration — the desktop hardcodes
 *  none of it. */
export type ConfiguredAgent = { key: string; label: string; command: string };

const STORE_KEY = 'temper-agent-panel-v1';
const EXPANDED_KEY = 'temper-agent-panel-expanded-v1';

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
	/** The engagement's width: expanded when the work needs room. Closed with the panel —
	 *  the expand choice is a device fact like the panel's own. */
	expanded = $state<boolean>(false);
	// The work record's open facts — set when the conversation opens, written when it closes.
	openedAt = $state<string>('');
	recordKey = $state<string>('');
	/** The last reference the agent was shown in this conversation; a new conversation forgets it. */
	lastReferenceUri = $state<string | null>(null);
	/** What the live conversation was started for, if anything. */
	scope = $state<SessionScope | null>(null);
	/** Whether the scope has gone to the agent yet — it goes once, with the first prompt. */
	scopeShared = $state<boolean>(false);
	/** The scope last started with on this device — Start offers it first. A device fact. */
	lastScope = $state<SessionScope | null>(null);
	/**
	 * The handoff in flight (slice 5): the conversation id the handoff prompt went to, and the
	 * turn that will carry the agent's proposal. Null when nothing is handed over.
	 */
	handoff = $state<{ conversationId: string; turn: number } | null>(null);
	/** The listeners' unarms, assigned when they arm; never called — the store outlives every
	 *  surface it decorates, and closing the conversation ends the conversation itself. */
	private unlisten: (() => void) | null = null;
	private unlistenAsk: (() => void) | null = null;
	private unlistenRoster: (() => void) | null = null;
	private initialised = false;

	init(): void {
		if (this.initialised) return;
		this.initialised = true;
		this.restorePanel();
		this.restoreLastScope();
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
			const wide = localStorage.getItem(EXPANDED_KEY);
			if (wide !== null) this.expanded = wide === 'true';
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

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		try {
			localStorage.setItem(EXPANDED_KEY, String(expanded));
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
		// The settings room rewrites the roster (a hand save, a removal, a preset
		// selection): the core says so, and the picker re-reads. The listener lives here,
		// with the store, so every surface that renders the roster follows.
		listen('device-roster-changed', () => {
			this.loadAgents();
		}).then((u) => {
			this.unlistenRoster = u;
		});
	}

	/** The declared-at-start directory is also the preference: a store that cannot be written
	 *  does not fail a conversation that has already begun. */
	private rememberWorkingDir(): void {
		invoke('settings_set_working_dir', { dir: this.workingDir.trim() }).catch(() => {});
	}

	private restoreLastScope(): void {
		try {
			const raw = localStorage.getItem(SCOPE_STORE);
			if (!raw) return;
			const parsed = JSON.parse(raw) as Partial<SessionScope>;
			if (
				(parsed.kind === 'context' || parsed.kind === 'goal') &&
				typeof parsed.ref === 'string' &&
				typeof parsed.name === 'string'
			) {
				this.lastScope = { kind: parsed.kind, ref: parsed.ref, name: parsed.name };
			}
		} catch {
			// No remembered scope: Start offers the list in its own order.
		}
	}

	private rememberScope(scope: SessionScope | null): void {
		this.lastScope = scope;
		try {
			if (scope) localStorage.setItem(SCOPE_STORE, JSON.stringify(scope));
			else localStorage.removeItem(SCOPE_STORE);
		} catch {
			// A store that cannot be written costs the next Start its default, no more.
		}
	}

	async start(options: { scope?: SessionScope | null } = {}): Promise<void> {
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
			this.scope = options.scope ?? null;
			this.scopeShared = false;
			if (options.scope !== undefined) this.rememberScope(options.scope);
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
		// The session's scope goes with the first prompt only. The room in view goes with the first
		// prompt, then only when it has changed since the last prompt that carried one. The
		// transcript records exactly what went with the text.
		const scope = this.scope && !this.scopeShared ? scopeReference(this.scope) : null;
		const inView = inViewReference();
		const reference = inView && inView.uri !== this.lastReferenceUri ? inView : null;
		const previous = this.lastReferenceUri;
		if (reference) this.lastReferenceUri = reference.uri;
		if (scope) this.scopeShared = true;
		const references = [scope, reference].filter((r): r is InView => r !== null);
		this.messages.push(
			references.length
				? { role: 'user', text, with: references.map((r) => r.name).join(' and ') }
				: { role: 'user', text }
		);
		this.prompting = true;
		this.error = '';
		try {
			await invoke<string>('acp_prompt', {
				conversationId: this.conversation.conversationId,
				text,
				references
			});
		} catch (e) {
			this.error = String(e);
			// Nothing reached the agent: the next prompt shares the scope and the room again.
			if (reference) this.lastReferenceUri = previous;
			if (scope) this.scopeShared = false;
		} finally {
			this.prompting = false;
		}
	}

	/**
	 * Sends the document room's handoff prompt (slice 5) and returns when the turn ends. The
	 * prompt is composed by the caller (the room, from the refusal's material); the store sends
	 * it as this person's words in the transcript, records the handoff so the caller can extract
	 * the proposal from this turn's reply, and offers no resource references — the material is
	 * fenced text inside the prompt itself, never a `temper:` URI the agent would resolve.
	 */
	async sendHandoff(text: string): Promise<void> {
		if (!this.conversation) throw new Error('no agent conversation is live');
		if (this.prompting) throw new Error('the agent is already responding');
		const turn = this.messages.length + 1;
		this.messages.push({ role: 'user', text, with: 'the document handoff' });
		this.prompting = true;
		this.error = '';
		this.handoff = { conversationId: this.conversation.conversationId, turn };
		try {
			await invoke<string>('acp_prompt', {
				conversationId: this.conversation.conversationId,
				text,
				references: []
			});
		} catch (e) {
			this.error = String(e);
			this.handoff = null;
			throw e;
		} finally {
			this.prompting = false;
		}
	}

	/**
	 * The index of the transcript line the handoff turn's reply starts at: every assistant
	 * chunk after it belongs to the turn the caller watches.
	 */
	handoffTurnStart(): number | null {
		return this.handoff?.turn ?? null;
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
		const scope = this.scope;
		this.conversation = null;
		this.scope = null;
		this.scopeShared = false;
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
					closedAt: new Date().toISOString(),
					scope: scope ? { kind: scope.kind, ref: scope.ref } : null
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
