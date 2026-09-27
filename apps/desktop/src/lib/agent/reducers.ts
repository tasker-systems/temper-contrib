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

export type ChatMessage = {
	role: 'user' | 'assistant' | 'system';
	text: string;
	toolCallId?: string;
	status?: string;
};

export function chunkText(update: AcpUpdate): string | null {
	const content = update.content;
	return update.sessionUpdate === 'agent_message_chunk' &&
		content?.type === 'text' &&
		typeof content.text === 'string'
		? content.text
		: null;
}

/** One transcript line per tool call: updates refresh the existing entry
 *  rather than appending a new line per notification. */
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
