// The reducers' witnesses: one behaviour per case, no component. Each
// carried over from the transcript behaviour that already worked.
import { describe, expect, it } from 'vitest';
import {
	type AskedNotice,
	applyConfigUpdate,
	applyModeUpdate,
	applyNotice,
	applyUpdate,
	askLabel,
	type ChatMessage,
	chunkText,
	type DeclaredConfigOption,
	declaredSelection,
	EMPTY_SELECTION
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

// --- The declared selection ------------------------------------------------

const selectOption = (id: string, name: string, currentValue: string): DeclaredConfigOption => ({
	id,
	name,
	category: null,
	select: { currentValue, options: [{ value: currentValue, name: `${name} value` }] }
});

describe('declaredSelection', () => {
	it('carries what session/new declared, verbatim', () => {
		const selection = declaredSelection({
			modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] },
			configOptions: [selectOption('model', 'Model', 'sonnet')]
		});
		expect(selection.modes).toEqual({
			currentModeId: 'code',
			availableModes: [{ id: 'code', name: 'Code' }]
		});
		expect(selection.configOptions).toHaveLength(1);
	});

	it('an agent that declares nothing is the empty selection, not an error', () => {
		expect(declaredSelection({})).toEqual(EMPTY_SELECTION);
		expect(declaredSelection({ modes: null, configOptions: null })).toEqual(EMPTY_SELECTION);
	});
});

describe('applyModeUpdate', () => {
	it('a declared mode change lands on the declared current mode', () => {
		const selection = declaredSelection({
			modes: {
				currentModeId: 'ask',
				availableModes: [
					{ id: 'ask', name: 'Ask' },
					{ id: 'code', name: 'Code' }
				]
			}
		});
		applyModeUpdate(selection, 'code');
		expect(selection.modes?.currentModeId).toBe('code');
	});

	it('a mode update on an agent that declared no modes changes nothing', () => {
		const selection = declaredSelection({});
		applyModeUpdate(selection, 'code');
		expect(selection.modes).toBeNull();
	});
});

describe('applyConfigUpdate', () => {
	it('the full declared set replaces the one rendered', () => {
		const selection = declaredSelection({
			configOptions: [selectOption('model', 'Model', 'sonnet')]
		});
		applyConfigUpdate(selection, [selectOption('model', 'Model', 'opus')]);
		expect(selection.configOptions[0].select?.currentValue).toBe('opus');
	});

	it('an agent revoking its options clears them — nothing stale is kept', () => {
		const selection = declaredSelection({
			configOptions: [selectOption('model', 'Model', 'sonnet')]
		});
		applyConfigUpdate(selection, []);
		expect(selection.configOptions).toEqual([]);
	});
});
