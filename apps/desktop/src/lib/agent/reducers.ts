/**
 * Pure reducers over the engagement's state: applied by the session store,
 * unit-tested without a component. One behaviour per function, carried over
 * from the transcript behaviour that already worked — one transcript line
 * per tool call (updates refresh the entry, never append), an ask's
 * resolution lands in the transcript answered or cancelled, never dropped.
 */

/** The permission ask passes through exactly as the agent declared it —
 *  option ids, names, and kinds are the agent's own, never a desktop vocabulary. */
export type DeclaredOption = { optionId: string; name: string; kind: string };
export type AskedNotice = {
	kind: 'asked';
	conversationId: string;
	askId: string;
	toolCall: { toolCallId?: string; title?: string; name?: string; rawInput?: unknown };
	options: DeclaredOption[];
};
export type ResolvedNotice = {
	kind: 'resolved';
	conversationId: string;
	askId: string;
	outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
};
export type AskNotice = AskedNotice | ResolvedNotice;

export type AcpUpdate = {
	sessionUpdate?: string;
	content?: { type?: string; text?: string };
	title?: string;
	toolCallId?: string;
	status?: string;
};

/** The agent's declared mode state, passed through verbatim. A mode is the
 *  agent's own id, name, and optional description — the desktop invents no
 *  mode vocabulary. */
export type DeclaredMode = { id: string; name: string; description?: string };
export type DeclaredModeState = { currentModeId: string; availableModes: DeclaredMode[] };
/** The agent's declared category, its own word — `mode`, `model`,
 *  `model_config`, `thought_level`, or anything else it declares, including
 *  names the desktop has never heard. */
export type DeclaredCategory = string | null;
/** One declared configuration option: a select with its choices, or a
 *  boolean toggle. Whatever the agent declared is what renders. */
export type DeclaredConfigOption = {
	id: string;
	name: string;
	category: DeclaredCategory;
	select?: { currentValue: string; options: { value: string; name: string }[] };
	boolean?: { currentValue: boolean };
};

export type ChatMessage = {
	role: 'user' | 'assistant' | 'system';
	text: string;
	/** What went with a person's prompt: the name of the room shared with the agent. */
	with?: string;
	toolCallId?: string;
	status?: string;
};

/** The declared selection, established from what the agent declares and
 *  changed only by declared change — never guessed, never defaulted. */
export type DeclaredSelection = {
	modes: DeclaredModeState | null;
	configOptions: DeclaredConfigOption[];
};

/** A conversation that declares nothing is the empty selection, not an
 *  error: the surface shows nothing for it. */
export const EMPTY_SELECTION: DeclaredSelection = { modes: null, configOptions: [] };

/** Reads what `session/new` declared into the selection. Unknown shapes are
 *  dropped at the edge; nothing is widened into a desktop vocabulary. */
export function declaredSelection(info: {
	modes?: DeclaredModeState | null;
	configOptions?: DeclaredConfigOption[] | null;
}): DeclaredSelection {
	const modes = info.modes ?? null;
	const configOptions = Array.isArray(info.configOptions) ? info.configOptions : [];
	return { modes, configOptions };
}

/** `current_mode_update`: the agent has changed its own current mode. */
export function applyModeUpdate(selection: DeclaredSelection, modeId: string): void {
	if (selection.modes) selection.modes.currentModeId = modeId;
}

/** `config_option_update`: the agent has changed configuration — the full
 *  declared set arrives, replacing the one rendered. */
export function applyConfigUpdate(
	selection: DeclaredSelection,
	options: DeclaredConfigOption[]
): void {
	selection.configOptions = Array.isArray(options) ? options : [];
}

export function chunkText(update: AcpUpdate): string | null {
	const content = update.content;
	return update.sessionUpdate === 'agent_message_chunk' &&
		content?.type === 'text' &&
		typeof content.text === 'string'
		? content.text
		: null;
}

/** One transcript line per tool call: updates refresh the existing entry
 *  rather than appending a new line per notification. Declared-change
 *  shapes (`current_mode_update`, `config_option_update`) are handled by
 *  [`applyModeUpdate`] and [`applyConfigUpdate`] against the selection, not
 *  here — the transcript and the selection are different state. */
export function applyUpdate(messages: ChatMessage[], update: AcpUpdate): void {
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

export function askLabel(ask: AskedNotice): string {
	return ask.toolCall.title ?? ask.toolCall.name ?? ask.toolCall.toolCallId ?? 'a tool call';
}

/** What happened to an ask lands in the transcript: answered, or cancelled
 *  because no one could be asked — visible either way, never dropped. */
export function applyNotice(messages: ChatMessage[], asks: AskedNotice[], notice: AskNotice): void {
	if (notice.kind === 'asked') {
		if (!asks.some((a) => a.askId === notice.askId)) asks.push(notice);
		return;
	}
	const index = asks.findIndex((a) => a.askId === notice.askId);
	const asked = index >= 0 ? asks.splice(index, 1)[0] : null;
	const label = asked ? askLabel(asked) : 'an ask';
	const outcome = notice.outcome;
	if (outcome.outcome === 'selected') {
		const chosen = asked?.options.find((o) => o.optionId === outcome.optionId);
		messages.push({
			role: 'system',
			text: `asked to ${label} — answered: ${chosen?.name ?? outcome.optionId}`
		});
	} else {
		messages.push({
			role: 'system',
			text: `asked to ${label} — cancelled: no one was asked`
		});
	}
}

/** A view the agent presented, parked until the desktop has checked it. The spec is the agent's
 *  own, verbatim; `agent` is how its init answer named itself. */
export type PresentedNotice = {
	kind: 'presented';
	conversationId: string;
	presentedId: string;
	agent: string;
	spec: unknown;
};
/** How a presentation ended — the same closed object the agent's tool result carries. `rendered`
 *  means checked and mounted, never that the person has seen it; a refusal names the catalog
 *  version and every reason. */
export type PresentOutcome =
	| { ok: 'rendered' }
	| { ok: 'refused'; catalogVersion: string; reasons: string[] };
export type PresentResolvedNotice = {
	kind: 'resolved';
	conversationId: string;
	presentedId: string;
	outcome: PresentOutcome;
};
export type PresentNotice = PresentedNotice | PresentResolvedNotice;

/** How many refusal reasons the transcript line carries, and how long each may be. */
const SHOWN_REASONS = 5;
const REASON_LENGTH = 160;

/** A refusal reason as the transcript shows it. Reasons echo the agent's own element keys, so a
 *  reason is flattened to one line and cut short — agent text never reads as desktop lines. */
function shownReason(reason: string): string {
	const flat = reason.replace(/\p{Cc}+/gu, ' ');
	return flat.length > REASON_LENGTH ? `${flat.slice(0, REASON_LENGTH)}…` : flat;
}

function shownReasons(reasons: string[]): string {
	const shown = reasons.slice(0, SHOWN_REASONS).map(shownReason).join('; ');
	const more = reasons.length - SHOWN_REASONS;
	return more > 0 ? `${shown}; and ${more} more` : shown;
}

/** A presentation's end lands in the transcript once — rendered, or refused with its reasons —
 *  and leaves the pending list. A resolution for a presentation this store never saw pending
 *  still lands: the end is recorded, never dropped. */
export function applyPresentNotice(
	messages: ChatMessage[],
	pending: PresentedNotice[],
	notice: PresentNotice
): void {
	if (notice.kind === 'presented') {
		if (!pending.some((p) => p.presentedId === notice.presentedId)) pending.push(notice);
		return;
	}
	const index = pending.findIndex((p) => p.presentedId === notice.presentedId);
	if (index >= 0) pending.splice(index, 1);
	const outcome = notice.outcome;
	messages.push({
		role: 'system',
		text:
			outcome.ok === 'rendered'
				? 'presented a view — checked and rendered'
				: `presented a view — refused by ${outcome.catalogVersion}: ${shownReasons(outcome.reasons)}`
	});
}
