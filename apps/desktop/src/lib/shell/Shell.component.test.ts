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
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSession } from '$lib/agent/session.svelte';
import type { DocOpened } from '$lib/document';
import { temperViews } from '$lib/temper-views.svelte';
import { homeReads } from './home-reads.svelte';
import { shellPanels } from './panels.svelte';
import Shell from './Shell.svelte';
import { HOME_TAB, tabs } from './tabs.svelte';

type Call = { cmd: string; args: Record<string, unknown> | undefined };
const calls: Call[] = [];
const handlers: Record<string, (event: { payload: unknown }) => void> = {};

const A = '01a0e020-a6d7-7420-b924-68f5e89f354b';
const B = '01a0e0b8-39a6-7c42-97a4-3c1380308dc7';
const NEW = '01a0f100-0000-7000-8000-000000000001';

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

const SESSION = '01a0e79d-6442-71b1-ad4a-5cd2ae3939c2';
const C = '01a0e327-ef19-7d72-b7b2-2dd45a028cc9';

/** What the hub answers home, and which ids temper resolves — each home test sets its own. */
let hubView: { entries: unknown[]; queued: number; thisDevice?: string };
let resolvable: Set<string>;
let sessionMarkdown: string | null;
const context = (id: string, slug: string, updated: string, resourceCount = 59) => ({
	id,
	name: slug,
	slug,
	ownerRef: '+temper-dev',
	resourceCount,
	updated
});
const CONTRIB = context('ctx-1', 'contrib', '2026-09-27T00:00:00Z');
/** The contexts temper answers — one, unless a test names more. */
let contextsList: unknown[];

/** Each context's shape, by id; a context with none set has never been clustered. */
let shapes: Record<string, unknown>;

/** What everything-visible answers — only the home tests that fall back to it set one. */
let recentWork: { total: number; rows: unknown[] } | null;

const row = (id: string, title: string, updated: string) => ({
	id,
	decoratedRef: `r-${id}`,
	title,
	docType: 'task',
	contextRef: '+temper-dev/contrib',
	updated
});

const hubEntry = (resource: string, leftAt: string, device = 'station') => ({
	resource,
	room: 'core/document',
	openedAt: '2026-09-28T09:00:00.000Z',
	leftAt,
	device
});

/** When set, the next `lens_resolve` fails as an unanswered read would. */
let failNextResolve = false;

/** What the core answers a bound table with: the lens's spec, its element filled — 5 rows, 2 a page. */
function boundTable(args?: Record<string, unknown>) {
	const view = args?.view as { offset: number; sort?: { key: string; order: string } };
	const spec = structuredClone(args?.spec) as {
		elements: Record<string, { props: Record<string, unknown> }>;
	};
	const binding = args?.binding as { element: string };
	const rows = [0, 1, 2, 3, 4]
		.slice(view.offset, view.offset + 2)
		.map((i) => ({ title: `row ${i}`, updated: '2026-10-01 11:31Z' }));
	const props = {
		total: 5,
		scope: 'resources in +temper-dev/contrib',
		label: 'resources',
		state: 'present',
		columns: [
			{ key: 'title', header: 'Title', kind: 'text', sortable: true },
			{ key: 'updated', header: 'Updated', kind: 'date', sortable: true }
		],
		rows,
		page: { offset: view.offset, size: 2, more: view.offset + rows.length < 5 },
		sort: view.sort ?? { key: 'updated', order: 'desc' }
	};
	spec.elements[binding.element].props = props;
	return { spec, refs: [] };
}

/** What the core answers a bound graph with: the lens's spec, its element filled — a small walk. */
function boundGraph(args?: Record<string, unknown>) {
	const spec = structuredClone(args?.spec) as {
		elements: Record<string, { props: Record<string, unknown> }>;
	};
	const binding = args?.binding as { element: string };
	const props = {
		total: 2,
		scope: `reached from ${A} within 1 hops`,
		label: 'neighbourhood',
		state: 'present',
		nodes: [
			{ id: A, label: 'Build the document room', ref: A },
			{ id: B, label: 'The desktop hub', ref: B }
		],
		edges: [
			{
				source: A,
				target: B,
				label: 'advances',
				edgeKind: 'leads_to',
				polarity: 'forward',
				weight: 0.5
			}
		]
	};
	spec.elements[binding.element].props = props;
	return { spec, refs: [] };
}

function routeInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
	calls.push({ cmd, args });
	switch (cmd) {
		case 'hub_recent_work':
			return Promise.resolve(hubView);
		case 'temper_recent_work':
			return Promise.resolve(recentWork);
		case 'temper_context_shape':
			return Promise.resolve(
				shapes[args?.contextId as string] ?? {
					regions: [],
					population: 0,
					emptiness: 'never_clustered',
					materializedAt: null
				}
			);
		case 'acp_start':
			return Promise.resolve({ conversationId: 'c1', sessionId: 's1', agentInfo: {} });
		case 'doc_open':
			if (args?.id === SESSION && sessionMarkdown !== null) {
				return Promise.resolve({
					...opened(SESSION),
					docType: 'session',
					markdown: sessionMarkdown
				});
			}
			return Promise.resolve(opened(args?.id as string));
		case 'lens_resolve':
			if (failNextResolve) {
				failNextResolve = false;
				return Promise.reject('temper did not answer');
			}
			return Promise.resolve(
				(args?.binding as { read?: string } | undefined)?.read === 'graph'
					? boundGraph(args)
					: boundTable(args)
			);
		case 'doc_connections':
			return Promise.resolve({ state: 'present', data: { total: 0, edges: [] } });
		case 'temper_resolve_refs':
			return Promise.resolve(
				((args?.ids as string[] | undefined) ?? [])
					.filter((id) => resolvable.has(id))
					.map((id) => ({
						state: 'resolved',
						id,
						title: `Resource ${id.slice(-4)}`,
						docType: 'task',
						contextRef: '+temper-dev/contrib',
						decoratedRef: `resource-${id}`
					}))
			);
		case 'temper_list_resources': {
			const filter = args?.filter as { docType?: string; owner?: string };
			if ((filter as { contextRef?: string })?.contextRef === '+temper-dev/contrib') {
				return Promise.resolve({
					total: 7,
					rows: [
						row('r-older', 'An older change', '2026-09-27T10:00:00Z'),
						row('r-newer', 'A newer change', '2026-09-28T10:00:00Z')
					]
				});
			}
			if (filter?.owner === '@me' && filter.docType === 'session') {
				return Promise.resolve(
					sessionMarkdown === null
						? { total: 0, rows: [] }
						: {
								total: 1,
								rows: [
									{
										id: SESSION,
										decoratedRef: `session-${SESSION}`,
										title: 'Session wrap',
										docType: 'session',
										contextRef: '+temper-dev/contrib',
										updated: new Date().toISOString()
									}
								]
							}
				);
			}
			return Promise.resolve(listPage(filter));
		}
		case 'temper_contexts':
			return Promise.resolve(contextsList);
		case 'doc_create':
			return Promise.resolve({
				state: 'created',
				id: NEW,
				decoratedRef: `a-document-${NEW}`,
				title: args?.title as string
			});
		case 'doc_save_meta':
			return Promise.resolve({ state: 'saved' });
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
	// The lenses a tab mounts are imported lazily. Load the document and bound lenses and the sanitizer once
	// here, so the first test to open a document does not pay for a cold import inside its own
	// wait — under load that alone can outlast it.
	beforeAll(async () => {
		await import('./lenses/DocumentLens.svelte');
		await import('./lenses/BoundLens.svelte');
		await import('$lib/markdown/sanitize');
	});

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
		shellPanels.setPaletteOpen(false);
		temperViews.reset();
		homeReads.reset();
		hubView = { entries: [], queued: 0, thisDevice: 'station' };
		resolvable = new Set();
		sessionMarkdown = null;
		recentWork = null;
		shapes = {};
		contextsList = [CONTRIB];
		failNextResolve = false;
		agentSession.lastScope = null;
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

	it('a rendered presentation lands its tab in the strip, unfocused, and opens its room on the line', async () => {
		const { container } = render(Shell);
		await startedConversationWithParkedAsk();
		await vi.waitFor(() => expect(handlers['acp-present']).toBeDefined());
		const activeBefore = tabs.activeId;

		const presented = {
			kind: 'presented',
			conversationId: 'c1',
			presentedId: 'presented-0',
			agent: 'opencode',
			spec: {
				root: 'r',
				elements: {
					r: { type: 'RegionState', props: { state: 'failed', label: 'history' }, children: [] }
				}
			}
		} as const;
		handlers['acp-present']({ payload: presented });
		await vi.waitFor(() =>
			expect(
				calls.some((c) => c.cmd === 'present_answer' && c.args?.presentedId === 'presented-0')
			).toBe(true)
		);
		handlers['acp-present']({
			payload: {
				kind: 'resolved',
				conversationId: 'c1',
				presentedId: 'presented-0',
				outcome: {
					ok: 'rendered',
					tab: {
						resource: '01a0f000-0000-7000-8000-00000000000a',
						artifact: '01a0f000-0000-7000-8000-00000000000b'
					}
				}
			}
		});

		// The tab is in the strip; the active tab is where it was.
		await vi.waitFor(() => expect(tabs.tabs.length).toBe(2));
		expect(tabs.activeId).toBe(activeBefore);
		const link = await vi.waitFor(() => {
			const b = [...container.querySelectorAll('.tab-link')].find((b) =>
				b.textContent?.includes('presented a view')
			);
			expect(b).toBeDefined();
			return b as HTMLButtonElement;
		});
		await fireEvent.click(link);
		await vi.waitFor(() => expect(tabs.activeId).not.toBe(activeBefore));
		expect(tabs.current(tabs.active).subject).toMatchObject({
			kind: 'presentation',
			resource: '01a0f000-0000-7000-8000-00000000000a'
		});
		expect(tabs.current(tabs.active).lens).toBe('core/presentation');
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

	it('a context opens on the bound table, filled by the core, and pages and sorts through it', async () => {
		const { container } = render(Shell);
		tabs.open({ kind: 'query', context: '+temper-dev/contrib' }, { where: 'new' });
		await waitFor(() =>
			expect(activeBody(container)?.querySelectorAll('tbody tr')).toHaveLength(2)
		);
		const resolves = () => calls.filter((c) => c.cmd === 'lens_resolve');
		expect(resolves()[0].args).toMatchObject({
			binding: { element: 'table', read: 'resource-list' },
			subject: { context: '+temper-dev/contrib' },
			view: { offset: 0 }
		});
		expect(activeBody(container).textContent).toContain(
			'1–2 of 5 resources in +temper-dev/contrib; 3 after it.'
		);

		await fireEvent.click(button(activeBody(container), 'Next page'));
		await waitFor(() => expect(activeBody(container).textContent).toContain('row 2'));
		expect(resolves().at(-1)?.args?.view).toEqual({ offset: 2, sort: undefined });
		expect(activeBody(container).textContent).toContain(
			'3–4 of 5 resources in +temper-dev/contrib; 2 before this page, 1 after it.'
		);

		// A new order starts from the first page.
		await fireEvent.click(button(activeBody(container), 'Title'));
		await waitFor(() =>
			expect(resolves().at(-1)?.args?.view).toEqual({
				offset: 0,
				sort: { key: 'title', order: 'asc' }
			})
		);
		await waitFor(() =>
			expect(
				activeBody(container).querySelector('th[aria-sort="ascending"]')?.textContent
			).toContain('Title')
		);
	});

	it('a page turn that fails keeps the table, says so, and can be tried again', async () => {
		const { container } = render(Shell);
		tabs.open({ kind: 'query', context: '+temper-dev/contrib' }, { where: 'new' });
		await waitFor(() =>
			expect(activeBody(container)?.querySelectorAll('tbody tr')).toHaveLength(2)
		);
		failNextResolve = true;
		await fireEvent.click(button(activeBody(container), 'Next page'));
		await waitFor(() =>
			expect(activeBody(container).querySelector('.failure')?.textContent).toContain(
				'could not be read: temper did not answer'
			)
		);
		// The page in hand is still drawn, its controls with it.
		expect(activeBody(container).textContent).toContain('row 0');
		await fireEvent.click(button(activeBody(container), 'Try again'));
		await waitFor(() => expect(activeBody(container).textContent).toContain('row 2'));
		expect(activeBody(container).querySelector('.failure')).toBeNull();
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
		await waitFor(() => expect(activeBody(container)?.querySelector('svg')).toBeTruthy());
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

		// The graph lens is bound: the switch lands on its read, the document never re-opened.
		await fireEvent.click(button(strip, 'graph'));
		await waitFor(() => expect(activeBody(container)?.querySelector('svg')).toBeTruthy());
		const graphReads = () => reads('lens_resolve').length;
		const readsAtGraph = graphReads();
		expect(readsAtGraph).toBeGreaterThan(0);
		await fireEvent.click(button(strip, 'document · core'));
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

	it('home is its pinned sections, in order, under their headings', async () => {
		const { container } = render(Shell);
		const home = activeBody(container);
		await waitFor(() => expect(home.querySelectorAll('[data-section]')).toHaveLength(6));
		expect([...home.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
			'Resume',
			'Awaiting you',
			'Start',
			'Explore'
		]);
		// Every section this build ships is built; none says it is waiting to land.
		expect(home.textContent).not.toContain("isn't built yet");
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

	it('resume returns to the last place of work in one gesture, through the lens it was seen in', async () => {
		hubView = {
			entries: [
				hubEntry(A, '2026-09-28T10:00:00.000Z'),
				hubEntry(C, '2026-09-28T09:30:00.000Z', 'laptop')
			],
			queued: 0,
			thisDevice: 'station'
		};
		resolvable = new Set([A, C]);
		const { container } = render(Shell);
		const resume = () =>
			activeBody(container).querySelector('[data-section="core/home-resume"]') as HTMLElement;
		await waitFor(() => expect(resume().querySelector('.card button')).toBeTruthy());
		expect(resume().querySelector('.card')?.textContent).toContain('You were in its document lens');
		expect(resume().querySelector('.card')?.textContent).not.toContain(' on ');
		// A place left on another device says which.
		expect(resume().textContent).toContain('on laptop');
		expect(resume().textContent).toContain('All 1 earlier places of work.');

		await fireEvent.click(resume().querySelector('.card button') as HTMLButtonElement);
		expect(tabs.tabs).toHaveLength(2);
		const step = tabs.current(tabs.active);
		expect(step.subject).toEqual({ kind: 'resource', id: A });
		expect(step.lens).toBe('core/document');

		// A second return focuses the same tab rather than opening another.
		tabs.activate(HOME_TAB);
		await fireEvent.click(resume().querySelector('.card button') as HTMLButtonElement);
		expect(tabs.tabs).toHaveLength(2);
		expect(tabs.current(tabs.active).subject).toEqual({ kind: 'resource', id: A });
	});

	it('resume offers no way back to a place temper no longer answers for', async () => {
		hubView = {
			entries: [hubEntry(B, '2026-09-28T10:00:00.000Z')],
			queued: 0,
			thisDevice: 'station'
		};
		const { container } = render(Shell);
		const card = () => activeBody(container).querySelector('[data-resume]') as HTMLElement | null;
		await waitFor(() => expect(card()?.textContent).toContain('Reference unavailable'));
		expect(card()?.querySelector('button')).toBeNull();
	});

	it('resume with nothing recorded says what would appear, and how', async () => {
		const { container } = render(Shell);
		await waitFor(() =>
			expect(activeBody(container).textContent).toContain('No places of work recorded yet.')
		);
	});

	it('the latest handoff quotes the session’s own next steps, and invents none', async () => {
		sessionMarkdown = '## Done\nThe shell.\n## Next\nTake up the home view.\n## Notes\nNone.';
		const { container } = render(Shell);
		const handoff = () =>
			activeBody(container).querySelector(
				'[data-section="temper-workflows/home-handoff"]'
			) as HTMLElement;
		await waitFor(() =>
			expect(handoff().querySelector('blockquote')?.textContent).toBe('Take up the home view.')
		);
		expect(handoff().textContent).toContain('excerpt · Next');
		expect(
			calls.some(
				(c) =>
					c.cmd === 'temper_list_resources' &&
					(c.args?.filter as { owner?: string } | undefined)?.owner === '@me' &&
					c.args?.limit === 1
			)
		).toBe(true);
	});

	it('a handoff with no next steps shows the session and quotes nothing', async () => {
		sessionMarkdown = '## Done\nThe shell, and nothing said about what comes next.';
		const { container } = render(Shell);
		const handoff = () =>
			activeBody(container).querySelector(
				'[data-section="temper-workflows/home-handoff"]'
			) as HTMLElement;
		await waitFor(() => expect(handoff().textContent).toContain('latest handoff'));
		await waitFor(() => expect(reads('doc_open').some((c) => c.args?.id === SESSION)).toBe(true));
		await Promise.resolve();
		expect(handoff().querySelector('blockquote')).toBeNull();
	});

	it('home reads once per show: hovering reads nothing, and showing it again reads once more', async () => {
		hubView = {
			entries: [hubEntry(A, '2026-09-28T10:00:00.000Z')],
			queued: 0,
			thisDevice: 'station'
		};
		resolvable = new Set([A]);
		sessionMarkdown = '## Next\nOne thing.';
		const { container } = render(Shell);
		await temperViews.refreshContexts();
		await waitFor(() => expect(activeBody(container).querySelector('blockquote')).toBeTruthy());
		await waitFor(() => expect(reads('temper_context_shape')).toHaveLength(1));
		expect(reads('hub_recent_work')).toHaveLength(1);
		const before = calls.length;
		for (const el of activeBody(container).querySelectorAll('a, button')) {
			await fireEvent.mouseEnter(el);
			await fireEvent.mouseOver(el);
		}
		expect(calls.length).toBe(before);

		tabs.open({ kind: 'place', place: 'settings' }, { where: 'new' });
		tabs.activate(HOME_TAB);
		await waitFor(() => expect(reads('hub_recent_work')).toHaveLength(2));
		await waitFor(() => expect(reads('temper_context_shape')).toHaveLength(2));
	});

	it('recently updated reads where you worked, newest first, and says how much it shows', async () => {
		hubView = {
			entries: [hubEntry(A, '2026-09-28T10:00:00.000Z')],
			queued: 0,
			thisDevice: 'station'
		};
		resolvable = new Set([A]);
		const { container } = render(Shell);
		const section = () =>
			activeBody(container).querySelector(
				'[data-section="temper-workflows/home-recent"]'
			) as HTMLElement;
		await waitFor(() =>
			expect(section().textContent).toContain(
				'recently updated in +temper-dev/contrib, where you worked last'
			)
		);
		const titles = [...section().querySelectorAll('.main')].map((e) => e.textContent);
		expect(titles).toEqual(['A newer change', 'An older change']);
		expect(section().textContent).toContain('2 of 7 recently updated; 5 not shown.');
		// It never claims to know what changed since you last engaged: the phrase appears only as
		// the disclaimer, quoted.
		const text = section().textContent ?? '';
		expect(text.match(/since you last engaged/gi)).toHaveLength(1);
		expect(text).toContain('“Since you last engaged” needs temper’s event feed');
	});

	it('recently updated falls back to everything visible when nothing you worked in is recorded, and says so', async () => {
		recentWork = { total: 3, rows: [row('r-1', 'Something visible', '2026-09-28T09:00:00Z')] };
		const { container } = render(Shell);
		const section = () =>
			activeBody(container).querySelector(
				'[data-section="temper-workflows/home-recent"]'
			) as HTMLElement;
		await waitFor(() =>
			expect(section().textContent).toContain('nothing you worked in is recorded yet')
		);
		expect(section().textContent).toContain('1 of 3 recently updated');
	});

	it('start begins a session scoped to what the person chose, and only then opens the panel', async () => {
		agentSession.setPanelOpen(false);
		const { container } = render(Shell);
		const start = () =>
			activeBody(container).querySelector('[data-section="core/home-start"]') as HTMLElement;
		await waitFor(() =>
			expect(start().querySelector('optgroup[label="Active goals"] option')).toBeTruthy()
		);
		expect(agentSession.panelOpen).toBe(false);
		const scope = start().querySelectorAll('select')[1] as HTMLSelectElement;
		const goal = start().querySelector(
			'optgroup[label="Active goals"] option'
		) as HTMLOptionElement;
		await fireEvent.change(scope, { target: { value: goal.value } });
		agentSession.workingDir = '/tmp/project';
		await fireEvent.click(button(start(), 'start session'));

		await waitFor(() => expect(agentSession.conversation).not.toBeNull());
		expect(agentSession.scope).toEqual({ kind: 'goal', ref: `goal-0-${A}`, name: 'goal 0' });
		expect(agentSession.panelOpen).toBe(true);
		await waitFor(() => expect(start().textContent).toContain('scoped to the goal goal 0'));
		// The scope is remembered on this device, and offered first next time.
		expect(agentSession.lastScope?.ref).toBe(`goal-0-${A}`);
	});

	it('explore shows the most recently updated contexts by their regions, bounded, and names the lenses it opens', async () => {
		contextsList = [
			context('ctx-old', 'old', '2026-09-01T00:00:00Z'),
			context('ctx-1', 'contrib', '2026-09-28T00:00:00Z'),
			context('ctx-core', 'core', '2026-09-27T00:00:00Z'),
			context('ctx-art', 'artifacts', '2026-09-26T00:00:00Z')
		];
		shapes = {
			'ctx-1': {
				regions: [
					{ label: 'the document room', members: 12 },
					{ label: null, members: 4 },
					{ label: 'settings and surface', members: 7 },
					{ label: 'agent hosting over ACP', members: 5 }
				],
				population: 5,
				emptiness: null,
				materializedAt: '2026-09-28T00:00:00Z'
			}
		};
		await temperViews.refreshContexts();
		const { container } = render(Shell);
		const explore = () =>
			activeBody(container).querySelector('[data-section="core/home-explore"]') as HTMLElement;
		await waitFor(() => expect(explore().querySelectorAll('.regions li')).toHaveLength(4));
		const cards = [...explore().querySelectorAll('[data-context]')].map((c) =>
			c.getAttribute('data-context')
		);
		expect(cards).toEqual(['+temper-dev/contrib', '+temper-dev/core', '+temper-dev/artifacts']);
		const first = explore().querySelector('[data-context="+temper-dev/contrib"]') as HTMLElement;
		expect(first.textContent).toContain('59 resources · 5 regions');
		expect([...first.querySelectorAll('.regions li')].map((l) => l.textContent)).toEqual([
			'the document room',
			'an unlabelled region of 4',
			'settings and surface',
			'+2 more'
		]);
		expect(explore().textContent).toContain('1 more context is in the ways-in panel.');
		expect(reads('temper_context_shape')).toHaveLength(3);

		await fireEvent.click(button(first, 'its shape'));
		const step = tabs.current(tabs.active);
		expect(step.subject).toEqual({ kind: 'query', context: '+temper-dev/contrib' });
		expect(step.lens).toBe('core/shape');
		await waitFor(() =>
			expect(activeBody(container).textContent).toContain('The shape lens isn’t built yet')
		);
	});

	it('explore says why a context shows no regions, in temper’s own terms', async () => {
		contextsList = [
			context('ctx-new', 'new', '2026-09-28T00:00:00Z'),
			context('ctx-hidden', 'hidden', '2026-09-27T00:00:00Z')
		];
		shapes = {
			'ctx-hidden': {
				regions: [],
				population: 0,
				emptiness: 'nothing_visible',
				materializedAt: null
			}
		};
		await temperViews.refreshContexts();
		const { container } = render(Shell);
		const card = (ref: string) =>
			activeBody(container).querySelector(`[data-context="${ref}"]`) as HTMLElement | null;
		await waitFor(() =>
			expect(card('+temper-dev/new')?.textContent).toContain(
				'not yet clustered — temper hasn’t derived regions here'
			)
		);
		await waitFor(() =>
			expect(card('+temper-dev/hidden')?.textContent).toContain('no regions you can read')
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
		shellPanels.setWaysOpen(true);
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
		shellPanels.setWaysOpen(true);
		const { container } = render(Shell);
		const ways = container.querySelector('nav[aria-label="Ways in"]') as HTMLElement;
		await waitFor(() => expect(ways.querySelector('a[title="goal 0"]')).toBeTruthy());
		await fireEvent.click(ways.querySelector('a[title="goal 0"]') as Element);
		expect(tabs.openCount).toBe(1);
		expect(tabs.current(tabs.active).subject).toEqual({ kind: 'resource', id: A });
	});

	it('the ways-in panel closes, from its own affordance, and reopens without reading again', async () => {
		shellPanels.setWaysOpen(true);
		const { container } = render(Shell);
		await waitFor(() => expect(reads('temper_list_resources')).toHaveLength(3));
		const panel = container.querySelector('nav[aria-label="Ways in"]');

		await fireEvent.click(
			panel?.querySelector('button[aria-label="Close the ways-in panel"]') as Element
		);
		expect(container.querySelector('.ways')?.hasAttribute('hidden')).toBe(true);
		expect(shellPanels.waysOpen).toBe(false);

		// The menu chip's entry reopens it: the menu opens, the entry is chosen, the menu closes.
		await fireEvent.click(container.querySelector('.chrome-menu .trigger') as Element);
		const entry = container.querySelector('.chrome-menu .entry-action') as HTMLButtonElement;
		expect(entry?.textContent).toContain('ways in');
		await fireEvent.click(entry);
		expect(container.querySelector('.ways')?.hasAttribute('hidden')).toBe(false);
		expect(shellPanels.waysOpen).toBe(true);

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

	it('the palette offers New resource here only when the room in view names a context', async () => {
		const { container } = render(Shell);
		tabs.open({ kind: 'query', context: '+temper-dev/contrib' }, { where: 'new' });

		await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
		const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
		const offered = [...dialog.querySelectorAll('[role="option"]')].find((o) =>
			o.textContent?.includes('New resource here')
		);
		expect(offered).toBeDefined();
		await fireEvent.keyDown(dialog.querySelector('input') as Element, { key: 'Escape' });

		// From a room that names no context the command is absent, never disabled-grey.
		tabs.activate(HOME_TAB);
		await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
		const home = container.querySelector('[role="dialog"]') as HTMLElement;
		expect(
			[...home.querySelectorAll('[role="option"]')].filter((o) =>
				o.textContent?.includes('New resource here')
			)
		).toHaveLength(0);
	});

	it('the palette offers New resource here on a resource tab, the resource’s own context riding', async () => {
		const { container } = render(Shell);
		tabs.open({ kind: 'resource', id: A }, { where: 'new' });
		await waitFor(() => expect(activeBody(container)?.querySelector('h1')).toBeTruthy());

		await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
		const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
		const offered = [...dialog.querySelectorAll('[role="option"]')].find((o) =>
			o.textContent?.includes('New resource here')
		);
		expect(offered).toBeDefined();
		await fireEvent.click(offered as Element);
		// The create room is a step on the same trail, the resource's own context —
		// the one its opening read named — riding the place.
		expect(tabs.current(tabs.active).subject).toEqual({
			kind: 'place',
			place: 'new-resource',
			context: '+temper-dev/contrib'
		});

		// A subject with no context of its own never offers the command.
		tabs.open({ kind: 'query', text: 'anything' }, { where: 'new' });
		await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
		const second = container.querySelector('[role="dialog"]') as HTMLElement;
		expect(
			[...second.querySelectorAll('[role="option"]')].filter((o) =>
				o.textContent?.includes('New resource here')
			)
		).toHaveLength(0);
	});

	it('a create from the palette lands the tab on the created resource', async () => {
		const { container } = render(Shell);
		tabs.open({ kind: 'query', context: '+temper-dev/contrib' }, { where: 'new' });

		await fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
		const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
		const command = [...dialog.querySelectorAll('[role="option"]')].find((o) =>
			o.textContent?.includes('New resource here')
		);
		await fireEvent.click(command as Element);
		// The create room is a step on the same trail, the context riding its subject.
		expect(tabs.current(tabs.active).subject).toEqual({
			kind: 'place',
			place: 'new-resource',
			context: '+temper-dev/contrib'
		});

		const body = () => activeBody(container);
		await vi.waitFor(() => expect(body().querySelector('input')).toBeTruthy());
		await fireEvent.input(body().querySelector('input') as Element, {
			target: { value: 'A fresh task' }
		});
		const create = [...body().querySelectorAll('button')].find(
			(b) => b.textContent === 'Create'
		) as HTMLButtonElement;
		await fireEvent.click(create);

		await vi.waitFor(() =>
			expect(tabs.current(tabs.active).subject).toEqual({ kind: 'resource', id: NEW })
		);
		expect(reads('doc_create')).toHaveLength(1);
		expect(reads('doc_create')[0].args).toEqual({
			contextId: 'ctx-1',
			docType: 'task',
			title: 'A fresh task'
		});
		// The document room opened on the created id through the one door.
		expect(reads('doc_open').some((c) => c.args?.id === NEW)).toBe(true);
		// The trail keeps where the create came from.
		expect(tabs.canBack(tabs.active)).toBe(true);
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

		const prompts = () =>
			reads('acp_prompt').map((c) => (c.args?.references as unknown[] | undefined)?.[0] ?? null);
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
		expect(reads('acp_prompt')[0].args?.references).toEqual([]);
	});

	it('a scoped session sends its scope with the first prompt only, before the room in view', async () => {
		render(Shell);
		agentSession.workingDir = '/tmp/project';
		await agentSession.start({
			scope: { kind: 'goal', ref: `a-goal-${C}`, name: 'The desktop register' }
		});
		tabs.open({ kind: 'resource', id: A }, { where: 'new' });
		await waitFor(() => expect(tabs.current(tabs.active).title).toBe('Build the document room'));
		agentSession.draft = 'Where do we start?';
		await agentSession.send();
		agentSession.draft = 'And then?';
		await agentSession.send();

		const sent = reads('acp_prompt').map((c) => c.args?.references);
		expect(sent).toEqual([
			[
				{ uri: `temper:a-goal-${C}`, name: 'goal The desktop register' },
				{ uri: `temper:a-document-${A}`, name: 'Build the document room' }
			],
			[]
		]);
		expect(agentSession.messages.find((m) => m.role === 'user')?.with).toBe(
			'goal The desktop register and Build the document room'
		);

		// The work record links the scope when the session closes.
		await agentSession.close();
		const record = reads('temper_write_work_record')[0].args?.facts as { scope: unknown };
		expect(record.scope).toEqual({ kind: 'goal', ref: `a-goal-${C}` });
	});

	it('a prevented close asks, and the confirm clears the draft and closes (W-close-guard)', async () => {
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
		render(Shell);
		await vi.waitFor(() => expect(handlers['doc-close-requested']).toBeDefined());

		// The core prevented a close over a dirty draft and announced it: the person is asked.
		handlers['doc-close-requested']({ payload: null });
		await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
		expect(confirm.mock.calls[0][0]).toContain('unsaved draft');

		// The confirm clears the core's flag and closes past the guard.
		await vi.waitFor(() => expect(reads('doc_close_confirmed')).toHaveLength(1));
		confirm.mockRestore();
	});

	it('a close the person declines never clears the draft', async () => {
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
		render(Shell);
		await vi.waitFor(() => expect(handlers['doc-close-requested']).toBeDefined());

		handlers['doc-close-requested']({ payload: null });
		await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
		// Nothing was sent to the core: the draft stands, and so does the dirty flag.
		expect(reads('doc_close_confirmed')).toHaveLength(0);
		confirm.mockRestore();
	});
});
