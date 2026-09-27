// The reducers' witnesses: one behaviour per case, no component. Each
// carried over from the transcript behaviour that already worked.
import { describe, expect, it } from 'vitest';
import {
	type AskedNotice,
	applyNotice,
	applyUpdate,
	askLabel,
	type ChatMessage,
	chunkText
} from './reducers';

const ask = (askId: string, title = 'Write witness.txt'): AskedNotice => ({
	kind: 'asked',
	conversationId: 'c1',
	askId,
	toolCall: { toolCallId: 'call-1', title },
	options: [
		{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
		{ optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
	]
});

describe('applyUpdate', () => {
	it('streams an assistant answer one chunk at a time', () => {
		const messages: ChatMessage[] = [];
		applyUpdate(messages, {
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'Hello' }
		});
		applyUpdate(messages, {
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: ' there' }
		});
		expect(messages).toEqual([{ role: 'assistant', text: 'Hello there' }]);
	});

	it('keeps one line per tool call, refreshing title and status', () => {
		const messages: ChatMessage[] = [];
		applyUpdate(messages, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file' });
		applyUpdate(messages, {
			sessionUpdate: 'tool_call_update',
			toolCallId: 't1',
			title: 'Read file',
			status: 'completed'
		});
		expect(messages).toEqual([
			{ role: 'system', text: 'Read file', toolCallId: 't1', status: 'completed' }
		]);
	});
});

describe('applyNotice', () => {
	it('records a chosen ask in the transcript with the declared name', () => {
		const messages: ChatMessage[] = [];
		const asks: AskedNotice[] = [];
		applyNotice(messages, asks, ask('ask-0'));
		expect(asks).toHaveLength(1);
		applyNotice(messages, asks, {
			kind: 'resolved',
			conversationId: 'c1',
			askId: 'ask-0',
			outcome: { outcome: 'selected', optionId: 'allow-once' }
		});
		expect(asks).toHaveLength(0);
		expect(messages.at(-1)?.text).toBe('asked to Write witness.txt — answered: Allow once');
	});

	it('names a cancelled ask as no one was asked, never dropping it', () => {
		const messages: ChatMessage[] = [];
		const asks: AskedNotice[] = [];
		applyNotice(messages, asks, ask('ask-0'));
		applyNotice(messages, asks, {
			kind: 'resolved',
			conversationId: 'c1',
			askId: 'ask-0',
			outcome: { outcome: 'cancelled' }
		});
		expect(messages.at(-1)?.text).toBe('asked to Write witness.txt — cancelled: no one was asked');
	});

	it('a duplicate ask notice is not stacked twice', () => {
		const messages: ChatMessage[] = [];
		const asks: AskedNotice[] = [];
		applyNotice(messages, asks, ask('ask-0'));
		applyNotice(messages, asks, ask('ask-0'));
		expect(asks).toHaveLength(1);
		expect(askLabel(ask('ask-0'))).toBe('Write witness.txt');
		expect(
			chunkText({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } })
		).toBe('x');
		expect(chunkText({ sessionUpdate: 'tool_call' })).toBeNull();
	});
});
