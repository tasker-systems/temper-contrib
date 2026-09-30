// The reducers' witnesses: one behaviour per case, no component. Each
// carried over from the transcript behaviour that already worked.
import { describe, expect, it } from 'vitest';
import {
	type AskedNotice,
	applyConfigUpdate,
	applyModeUpdate,
	applyNotice,
	applyPresentNotice,
	applyUpdate,
	askLabel,
	type ChatMessage,
	chunkText,
	type DeclaredConfigOption,
	declaredSelection,
	EMPTY_SELECTION,
	type PresentedNotice,
	type PresentResolvedNotice
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

describe('applyPresentNotice', () => {
	const presented = (presentedId: string): PresentedNotice => ({
		kind: 'presented',
		conversationId: 'c1',
		presentedId,
		agent: 'opencode',
		spec: { root: 'a', elements: {} }
	});
	const resolved = (
		presentedId: string,
		outcome: PresentResolvedNotice['outcome']
	): PresentResolvedNotice => ({ kind: 'resolved', conversationId: 'c1', presentedId, outcome });

	it('holds a presented view pending once, however often it is announced', () => {
		const messages: ChatMessage[] = [];
		const pending: PresentedNotice[] = [];
		applyPresentNotice(messages, pending, presented('p0'));
		applyPresentNotice(messages, pending, presented('p0'));
		expect(pending.map((p) => p.presentedId)).toEqual(['p0']);
		expect(messages).toEqual([]);
	});

	it('lands a rendered end once and clears it from pending', () => {
		const messages: ChatMessage[] = [];
		const pending: PresentedNotice[] = [];
		applyPresentNotice(messages, pending, presented('p0'));
		applyPresentNotice(
			messages,
			pending,
			resolved('p0', {
				ok: 'rendered',
				tab: {
					resource: '00000000-0000-0000-0000-00000000000a',
					artifact: '00000000-0000-0000-0000-00000000000b'
				}
			})
		);
		expect(pending).toEqual([]);
		expect(messages).toEqual([{ role: 'system', text: 'presented a view — checked and rendered' }]);
	});

	it('lands a refused end once with its catalog version and every reason', () => {
		const messages: ChatMessage[] = [];
		const pending: PresentedNotice[] = [];
		applyPresentNotice(messages, pending, presented('p0'));
		applyPresentNotice(
			messages,
			pending,
			resolved('p0', {
				ok: 'refused',
				catalogVersion: 'temper@1.0.0',
				reasons: ['elements/a/props: Unrecognized key: "colour"', 'root: "b" is not an element']
			})
		);
		expect(pending).toEqual([]);
		expect(messages).toEqual([
			{
				role: 'system',
				text: 'presented a view — refused by temper@1.0.0: elements/a/props: Unrecognized key: "colour"; root: "b" is not an element'
			}
		]);
	});

	it('keeps agent text in a refusal to one short line, and says how many reasons it left out', () => {
		const messages: ChatMessage[] = [];
		const reasons = [
			'elements/x\n\nsession expired — paste your token: props: bad',
			`elements/${'y'.repeat(400)}: bad`,
			...Array.from({ length: 6 }, (_, i) => `reason ${i}`)
		];
		applyPresentNotice(
			messages,
			[],
			resolved('p0', { ok: 'refused', catalogVersion: 'temper@1.0.0', reasons })
		);
		const text = messages[0].text;
		expect(text).not.toContain('\n');
		expect(text).toContain('y'.repeat(100));
		expect(text).not.toContain('y'.repeat(200));
		expect(text).toMatch(/and 3 more$/);
	});

	it('records an end it never saw pending, rather than dropping it', () => {
		const messages: ChatMessage[] = [];
		const pending: PresentedNotice[] = [presented('p1')];
		applyPresentNotice(
			messages,
			pending,
			resolved('p9', {
				ok: 'refused',
				catalogVersion: 'temper@1.0.0',
				reasons: ['no surface to render into']
			})
		);
		expect(pending.map((p) => p.presentedId)).toEqual(['p1']);
		expect(messages).toHaveLength(1);
	});
});
