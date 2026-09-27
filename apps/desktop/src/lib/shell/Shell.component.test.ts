// The shell's witnesses. The engagement is the session's, not a tab's: switching tabs leaves the
// conversation running, streamed output landing and a parked ask answerable, and the ask surface
// is never released. Every open tab is a live room: a background tab keeps its reads when shown
// again. A lens that is not built yet is named, not guessed. Reach reads in the same place
// whatever lens is in view. `invoke` is mocked and records every call.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSession } from '$lib/agent/session.svelte';
import type { DocOpened } from '$lib/document';
import Shell from './Shell.svelte';
import { HOME_TAB, tabs } from './tabs.svelte';

type Call = { cmd: string; args: Record<string, unknown> | undefined };
const calls: Call[] = [];
const handlers: Record<string, (event: { payload: unknown }) => void> = {};

const A = '01a0e020-a6d7-7420-b924-68f5e89f354b';
const B = '01a0e0b8-39a6-7c42-97a4-3c1380308dc7';

const opened = (id: string): DocOpened => ({
	state: 'opened',
	id,
	title: id === A ? 'Build the document room' : 'The desktop hub',
	docType: 'task',
	contextRef: '+temper-dev/contrib',
	decoratedRef: `a-document-${id}`,
	ownerHandle: 'someone',
	created: '2026-09-26T00:00:00+00:00',
	updated: '2026-09-27T00:00:00+00:00',
	managedMeta: null,
	openMeta: null,
	markdown: `See [the hub](/r/${B}).`,
	bodyHash: 'h1'
});

function routeInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
	calls.push({ cmd, args });
	switch (cmd) {
		case 'acp_start':
			return Promise.resolve({ conversationId: 'c1', sessionId: 's1', agentInfo: {} });
		case 'doc_open':
			return Promise.resolve(opened(args?.id as string));
		case 'doc_connections':
			return Promise.resolve({ state: 'present', data: { total: 0, edges: [] } });
		case 'temper_resolve_refs':
			return Promise.resolve([]);
		default:
			return Promise.resolve(null);
	}
}

const declaredAsk = {
	kind: 'asked',
	conversationId: 'c1',
	askId: 'ask-0',
	toolCall: { toolCallId: 'call-1', title: 'Write witness.txt' },
	options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
};

const reads = (cmd: string) => calls.filter((c) => c.cmd === cmd);

function button(container: HTMLElement, text: string): HTMLButtonElement {
	const found = [...container.querySelectorAll('button')].find((b) =>
		b.textContent?.includes(text)
	);
	if (!found) throw new Error(`no button "${text}"`);
	return found as HTMLButtonElement;
}

/** The body of the active tab. */
const activeBody = (container: HTMLElement) =>
	container.querySelector(`.tab-body[data-tab="${tabs.activeId}"]`) as HTMLElement;

describe('the shell', () => {
	beforeEach(() => {
		calls.length = 0;
		vi.mocked(invoke).mockImplementation(routeInvoke as never);
		vi.mocked(listen).mockImplementation(async (event, handler) => {
			handlers[event as string] = handler as (e: { payload: unknown }) => void;
			return () => {};
		});
		for (const tab of [...tabs.tabs]) if (tab.id !== HOME_TAB) tabs.close(tab.id);
		tabs.activate(HOME_TAB);
		agentSession.conversation = null;
		agentSession.messages = [];
		agentSession.asks = [];
		agentSession.selection = { modes: null, configOptions: [] };
		// The roster is seeded, not loaded: `init()` is idempotent, so the store's own read would
		// be a first-test-only effect — these witnesses test the engagement, not the roster read.
		agentSession.agents = [{ key: 'opencode', label: 'opencode', command: 'opencode acp' }];
		agentSession.agentKey = 'opencode';
		agentSession.prompting = false;
		agentSession.error = '';
		agentSession.setPanelOpen(true);
		agentSession.init();
	});

	/** A conversation with a transcript line and a parked ask, as the panel left it. */
	async function startedConversationWithParkedAsk(): Promise<void> {
		agentSession.workingDir = '/tmp/project';
		await agentSession.start();
		handlers['acp-ask']({ payload: declaredAsk });
		await vi.waitFor(() => expect(agentSession.asks).toHaveLength(1));
	}

	function streamed(text: string): void {
		handlers['acp-update']({
			payload: {
				conversationId: 'c1',
				sessionId: 's1',
				update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
			}
		});
	}

	it('a switch of tab leaves the conversation running', async () => {
		const { container } = render(Shell);
		await startedConversationWithParkedAsk();

		tabs.open({ kind: 'resource', id: A }, { where: 'new' });
		await waitFor(() => expect(activeBody(container)?.querySelector('h1')).toBeTruthy());
		streamed('working while you read…');
		tabs.activate(HOME_TAB);
		tabs.open({ kind: 'query', context: '+temper-dev/contrib' }, { where: 'new' });

		await vi.waitFor(() =>
			expect(container.querySelector('aside[aria-label="Agent"]')?.textContent).toContain(
				'working while you read…'
			)
		);
		expect(agentSession.asks).toHaveLength(1);
		expect(container.textContent).toContain('Write witness.txt');
		expect(reads('acp_start')).toHaveLength(1);
		expect(calls.some((c) => c.cmd === 'acp_ask_surface' && c.args?.present === false)).toBe(false);
	});

	it('a background tab keeps its reads when it is shown again', async () => {
		const { container } = render(Shell);
		tabs.open({ kind: 'resource', id: A }, { where: 'new' });
		const first = tabs.activeId;
		await waitFor(() =>
			expect(activeBody(container)?.querySelector('h1')?.textContent).toBe(
				'Build the document room'
			)
		);
		await fireEvent.click(button(activeBody(container), 'About this document'));
		await waitFor(() => expect(reads('doc_connections')).toHaveLength(1));
		const room = activeBody(container).querySelector('.about');

		tabs.open({ kind: 'resource', id: B }, { where: 'new' });
		await waitFor(() =>
			expect(activeBody(container)?.querySelector('h1')?.textContent).toBe('The desktop hub')
		);
		const before = calls.length;
		tabs.activate(first);
		await Promise.resolve();

		expect(calls.length).toBe(before);
		expect(activeBody(container).querySelector('.about')).toBe(room);
		expect(
			button(activeBody(container), 'Close about this document').getAttribute('aria-expanded')
		).toBe('true');
	});

	it('a lens that isn’t built yet is named, not guessed', async () => {
		const { container } = render(Shell);
		tabs.open({ kind: 'query', context: '+temper-dev/contrib' }, { where: 'new' });
		await waitFor(() =>
			expect(activeBody(container)?.textContent).toContain(
				'The table lens isn’t built yet — it lands with the table lens port.'
			)
		);
		expect(activeBody(container).textContent).toContain('+temper-dev/contrib');
		expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
			'table'
		);
	});

	it('reach reads in the same place, in the same words, whatever lens is in view', async () => {
		const { container } = render(Shell);
		await startedConversationWithParkedAsk();
		const reach = () => container.querySelector('aside[aria-label="Agent"] .reach');
		const seen: Array<[Element | null, string | undefined]> = [];

		seen.push([reach(), reach()?.textContent ?? undefined]);
		tabs.open({ kind: 'resource', id: A }, { where: 'new' });
		await waitFor(() => expect(activeBody(container)?.querySelector('h1')).toBeTruthy());
		seen.push([reach(), reach()?.textContent ?? undefined]);
		tabs.setLens(tabs.activeId, 'core/graph');
		await waitFor(() => expect(activeBody(container)?.textContent).toContain('graph lens'));
		seen.push([reach(), reach()?.textContent ?? undefined]);

		expect(seen[0][0]).not.toBeNull();
		expect(seen[0][1]).toContain('the desktop relays what it asks');
		for (const [node, text] of seen) {
			expect(node).toBe(seen[0][0]);
			expect(text).toBe(seen[0][1]);
		}
	});

	it('switching lens keeps the subject and re-reads nothing', async () => {
		const { container } = render(Shell);
		tabs.open({ kind: 'resource', id: A }, { where: 'new' });
		await waitFor(() => expect(activeBody(container)?.querySelector('h1')).toBeTruthy());
		const strip = container.querySelector('nav[aria-label="This room"]') as HTMLElement;
		expect(strip.textContent).toContain('through the lens of');

		await fireEvent.click(button(strip, 'graph'));
		await waitFor(() => expect(activeBody(container)?.textContent).toContain('graph lens'));
		await fireEvent.click(button(activeBody(container), 'document · core'));
		await waitFor(() => expect(activeBody(container)?.querySelector('h1')).toBeTruthy());
		expect(reads('doc_open')).toHaveLength(1);
	});

	it('a followed link opens in place; ⌘/Ctrl and middle clicks open a new tab; the way out walks back', async () => {
		const { container } = render(Shell);
		tabs.open({ kind: 'resource', id: A }, { where: 'new' });
		const tab = tabs.activeId;
		await waitFor(() => expect(activeBody(container)?.querySelector('.md-body a')).toBeTruthy());

		const link = () => activeBody(container).querySelector('.md-body a') as Element;
		await fireEvent.click(link(), { ctrlKey: true });
		expect(tabs.openCount).toBe(2);
		flushSync(() => tabs.activate(tab));
		await fireEvent(
			link(),
			new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
		);
		expect(tabs.openCount).toBe(3);
		flushSync(() => tabs.activate(tab));

		await fireEvent.click(link());
		expect(tabs.activeId).toBe(tab);
		expect(tabs.active.steps).toHaveLength(2);
		await waitFor(() =>
			expect(activeBody(container)?.querySelector('h1')?.textContent).toBe('The desktop hub')
		);

		const wayOut = container.querySelector('nav[aria-label="This room"] .t-way-out');
		expect(wayOut?.textContent).toContain('Build the document room');
		await fireEvent.click(wayOut as Element);
		await waitFor(() =>
			expect(activeBody(container)?.querySelector('h1')?.textContent).toBe(
				'Build the document room'
			)
		);
		expect(
			container.querySelector('nav[aria-label="This room"] .t-way-out')?.textContent
		).toContain('home');
	});

	it('home is pinned: no close, no way out, no room strip', () => {
		const { container } = render(Shell);
		const home = container.querySelector('[role="tab"]');
		expect(home?.textContent).toContain('home');
		expect(container.querySelector('button[aria-label^="Close home"]')).toBeNull();
		expect(container.querySelector('nav[aria-label="This room"]')).toBeNull();
		expect(container.textContent).toContain('0 open · 12 at most');
	});

	it('the agent panel closes and reopens without losing the engagement', async () => {
		const { container } = render(Shell);
		await startedConversationWithParkedAsk();
		const panel = container.querySelector('aside[aria-label="Agent"]');

		agentSession.setPanelOpen(false);
		await waitFor(() =>
			expect(container.querySelector('.agent')?.hasAttribute('hidden')).toBe(true)
		);
		const toggle = container.querySelector('.agent-toggle');
		expect(toggle?.textContent).toContain('◇ 1');
		expect(toggle?.getAttribute('aria-label')).toContain('awaiting your answer');

		await fireEvent.click(toggle as Element);
		expect(container.querySelector('aside[aria-label="Agent"]')).toBe(panel);
		expect(container.textContent).toContain('Write witness.txt');
		expect(reads('acp_start')).toHaveLength(1);
	});
});
