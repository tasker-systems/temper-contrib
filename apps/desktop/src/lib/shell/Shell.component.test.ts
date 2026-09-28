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
import { temperViews } from '$lib/temper-views.svelte';
import { shellPanels } from './panels.svelte';
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

/** A page per list: goals hold 2, tasks 11 (more than a first page), sessions none. */
function listPage(filter: { docType?: string }) {
	const totals: Record<string, number> = { goal: 2, task: 11, session: 0 };
	const total = totals[filter?.docType ?? ''] ?? 0;
	const limit = 8;
	return {
		total,
		rows: Array.from({ length: Math.min(total, limit) }, (_, i) => ({
			id: `${filter.docType}-${i}`,
			decoratedRef: `${filter.docType}-${i}-${i === 0 ? A : B}`,
			title: `${filter.docType} ${i}`,
			docType: filter.docType,
			contextRef: '+temper-dev/contrib',
			updated: '2026-09-27T00:00:00Z'
		}))
	};
}

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
		case 'temper_list_resources':
			return Promise.resolve(listPage(args?.filter as { docType?: string }));
		case 'temper_contexts':
			return Promise.resolve([
				{
					id: 'ctx-1',
					name: 'contrib',
					slug: 'contrib',
					ownerRef: '+temper-dev',
					resourceCount: 59,
					updated: '2026-09-27T00:00:00Z'
				}
			]);
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
		tabs.setAside = [];
		tabs.activate(HOME_TAB);
		shellPanels.setWaysOpen(true);
		shellPanels.setPaletteOpen(false);
		temperViews.reset();
		agentSession.lastReferenceUri = null;
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

	it('home is its pinned sections, in order, each unbuilt one named with what lands it', async () => {
		const { container } = render(Shell);
		const home = activeBody(container);
		await waitFor(() => expect(home.querySelectorAll('[data-section]')).toHaveLength(6));
		expect([...home.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
			'Resume',
			'Awaiting you',
			'Start',
			'Explore'
		]);
		const resume = home.querySelector('[data-section="core/home-resume"]') as HTMLElement;
		expect(resume.textContent).toContain("isn't built yet");
		expect(resume.textContent).toContain('drawn from the hub');
		// Nothing claims to be empty when nothing has been read.
		expect(home.textContent).not.toMatch(/No (places|sessions)/);
	});

	it('awaiting you never interrupts: a pending ask is shown on home, and opened only by the person', async () => {
		const { container } = render(Shell);
		agentSession.setPanelOpen(false);
		await startedConversationWithParkedAsk();
		const home = activeBody(container);
		const asks = () => home.querySelector('[data-section="core/home-asks"]') as HTMLElement;
		await waitFor(() => expect(asks()?.textContent).toContain('asks to run Write witness.txt'));
		expect(agentSession.panelOpen).toBe(false);

		await fireEvent.click(button(asks(), 'answer it in the agent panel'));
		expect(agentSession.panelOpen).toBe(true);
		await waitFor(() =>
			expect(document.activeElement?.getAttribute('data-ask')).toBe(declaredAsk.askId)
		);
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

	// --- Slice 3: the ways-in panel and the tab bound -------------------------------------------

	it('the ways-in panel groups its entries by plugin, each list bounded and saying what it omits', async () => {
		// Contexts and recent work are the window's shared reads (the layout starts them).
		await temperViews.refreshContexts();
		const { container } = render(Shell);
		const ways = container.querySelector('nav[aria-label="Ways in"]') as HTMLElement;
		expect(ways).not.toBeNull();
		const groups = [...ways.querySelectorAll('section')].map((g) => g.getAttribute('aria-label'));
		expect(groups).toEqual(['Ways in from core', 'Ways in from temper-workflows']);

		await waitFor(() =>
			expect(ways.textContent).toContain('8 of 11 tasks in progress; 3 not shown.')
		);
		expect(ways.textContent).toContain('All 2 active goals.');
		expect(ways.textContent).toContain('+temper-dev/contrib');
		expect(ways.textContent).toContain('2 plugins enabled · core, temper-workflows');
		const filters = reads('temper_list_resources').map((c) => c.args?.filter);
		expect(filters).toEqual([
			{ docType: 'goal', status: 'active' },
			{ docType: 'task', stage: 'in-progress' },
			{ docType: 'session' }
		]);
	});

	it('a ways-in entry opens its subject in a tab: from home, a new one', async () => {
		const { container } = render(Shell);
		const ways = container.querySelector('nav[aria-label="Ways in"]') as HTMLElement;
		await waitFor(() => expect(ways.querySelector('a[title="goal 0"]')).toBeTruthy());
		await fireEvent.click(ways.querySelector('a[title="goal 0"]') as Element);
		expect(tabs.openCount).toBe(1);
		expect(tabs.current(tabs.active).subject).toEqual({ kind: 'resource', id: A });
	});

	it('the ways-in panel closes, and reopens without reading again', async () => {
		const { container } = render(Shell);
		await waitFor(() => expect(reads('temper_list_resources')).toHaveLength(3));
		const panel = container.querySelector('nav[aria-label="Ways in"]');

		await fireEvent.click(container.querySelector('.ways-toggle') as Element);
		expect(container.querySelector('.ways')?.hasAttribute('hidden')).toBe(true);
		await fireEvent.click(container.querySelector('.ways-toggle') as Element);
		expect(container.querySelector('.ways')?.hasAttribute('hidden')).toBe(false);

		expect(container.querySelector('nav[aria-label="Ways in"]')).toBe(panel);
		expect(reads('temper_list_resources')).toHaveLength(3);
	});

	it('a thirteenth tab sets one aside and says which; the strip lists it to reopen', async () => {
		const { container } = render(Shell);
		for (let i = 0; i < 13; i++) {
			tabs.open(
				{ kind: 'query', context: `+temper-dev/c${String(i).padStart(2, '0')}` },
				{ where: 'new' }
			);
		}
		await waitFor(() => expect(container.textContent).toContain('12 open · 12 at most'));
		expect(container.querySelector('.notice')?.textContent).toContain(
			'Set aside +temper-dev/c00 to open +temper-dev/c12.'
		);

		const toggle = button(container, 'set aside · 1');
		await fireEvent.click(toggle);
		const listed = container.querySelector('ul[aria-label="Tabs set aside"]') as HTMLElement;
		expect(listed.textContent).toContain('+temper-dev/c00');
		await fireEvent.click(button(listed, '+temper-dev/c00'));
		expect(tabs.current(tabs.active).subject).toEqual({
			kind: 'query',
			context: '+temper-dev/c00'
		});
		expect(tabs.setAside).toHaveLength(1);
	});

	// --- Slice 4: the palette and the room in view -----------------------------------------------

	it('the palette opens on Ctrl-K, says it does not search, and closes on Escape', async () => {
		const { container } = render(Shell);
		await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
		const dialog = container.querySelector('[role="dialog"][aria-label="Command palette"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain('searching temper is the search lens, not built yet');
		await fireEvent.keyDown(dialog?.querySelector('input') as Element, { key: 'Escape' });
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});

	it('the palette opens settings, focusing a tab already showing it', async () => {
		const { container } = render(Shell);
		tabs.focusOrOpen({ kind: 'place', place: 'settings' });
		const settings = tabs.activeId;
		tabs.activate(HOME_TAB);

		await fireEvent.click(container.querySelector('.palette-trigger') as Element);
		const input = container.querySelector('[role="dialog"] input') as HTMLInputElement;
		await fireEvent.input(input, { target: { value: 'open settings' } });
		await fireEvent.keyDown(input, { key: 'Enter' });

		expect(tabs.activeId).toBe(settings);
		expect(tabs.openCount).toBe(1);
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});

	it('the palette switches the active tab’s lens, keeping its subject', async () => {
		const { container } = render(Shell);
		tabs.open({ kind: 'resource', id: A }, { where: 'new' });
		await waitFor(() => expect(activeBody(container)?.querySelector('h1')).toBeTruthy());

		await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
		const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
		const graph = [...dialog.querySelectorAll('[role="option"]')].find((o) =>
			o.textContent?.includes('graph lens')
		);
		await fireEvent.click(graph as Element);
		expect(tabs.current(tabs.active).lens).toBe('core/graph');
		expect(tabs.current(tabs.active).subject).toEqual({ kind: 'resource', id: A });
	});

	it('a palette section is bounded and says how many more a narrower filter would show', async () => {
		const { container } = render(Shell);
		await waitFor(() => expect(reads('temper_list_resources')).toHaveLength(3));
		await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
		const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
		await waitFor(() => expect(dialog.textContent).toContain('6 of 10 shown; 4 more'));
	});

	it('the room in view goes with the first prompt, then only when it has changed', async () => {
		const { container } = render(Shell);
		agentSession.workingDir = '/tmp/project';
		await agentSession.start();
		tabs.open({ kind: 'resource', id: A }, { where: 'new' });
		await waitFor(() => expect(tabs.current(tabs.active).title).toBe('Build the document room'));
		expect(container.querySelector('.in-view')?.textContent).toContain(
			'In view, shared with the agent:'
		);

		const prompts = () => reads('acp_prompt').map((c) => c.args?.reference ?? null);
		agentSession.draft = 'What is next?';
		await agentSession.send();
		agentSession.draft = 'And after that?';
		await agentSession.send();
		tabs.open({ kind: 'resource', id: B }, { where: 'new' });
		await waitFor(() => expect(tabs.current(tabs.active).title).toBe('The desktop hub'));
		agentSession.draft = 'And this one?';
		await agentSession.send();

		expect(prompts()).toEqual([
			{ uri: `temper:a-document-${A}`, name: 'Build the document room' },
			null,
			{ uri: `temper:a-document-${B}`, name: 'The desktop hub' }
		]);
		expect(
			agentSession.messages.filter((m) => m.role === 'user').map((m) => m.with ?? null)
		).toEqual(['Build the document room', null, 'The desktop hub']);
		await waitFor(() =>
			expect(container.querySelector('aside[aria-label="Agent"] .with')?.textContent).toContain(
				'Build the document room'
			)
		);
	});

	it('a place in view is named and never shared', async () => {
		const { container } = render(Shell);
		agentSession.workingDir = '/tmp/project';
		await agentSession.start();
		expect(container.querySelector('.in-view')?.textContent).toContain('not shared');
		agentSession.draft = 'Hello';
		await agentSession.send();
		expect(reads('acp_prompt')[0].args?.reference).toBeNull();
	});
});
