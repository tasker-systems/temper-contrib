// The document room's witnesses, mounted the way the shell mounts it: a tab's step host reads the
// body once, resolves the document lens, and hands the room the answer. `invoke` is mocked and
// records every command, so each witness can say exactly which reads the room issued, and when.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { EditorView } from '@codemirror/view';
import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connections, DocOpened, History, PanelRead, Related, Sources } from '$lib/document';
import StepHost from '$lib/shell/StepHost.svelte';
import { HOME_TAB, tabs } from '$lib/shell/tabs.svelte';

const ID = '01a0e020-a6d7-7420-b924-68f5e89f354b';
const PEER = '01a0e2a1-34a8-7a63-8fd6-cd3220c36191';
const PANEL_READS = ['doc_connections', 'doc_related', 'doc_history', 'doc_sources'];

const OPENED: Extract<DocOpened, { state: 'opened' }> = {
	state: 'opened',
	id: ID,
	title: 'Build the document room',
	docType: 'task',
	contextRef: '+temper-dev/contrib',
	decoratedRef: `build-the-document-room-${ID}`,
	ownerHandle: 'someone',
	created: '2026-09-26T00:00:00+00:00',
	updated: '2026-09-27T00:00:00+00:00',
	managedMeta: { 'temper-stage': 'in-progress' },
	openMeta: { tags: ['desktop', 'documents'] },
	markdown: '# Scope\n\nThe room, read-only.',
	bodyHash: 'h1'
};

const neighbours = (n: number): Related => ({
	total: n,
	neighbours: Array.from({ length: n }, (_, i) => ({
		id: `01a0e2a1-34a8-7a63-8fd6-${String(i).padStart(12, '0')}`,
		title: `Neighbour ${i}`,
		docType: 'task',
		excerpt: null,
		degree: 1,
		via: ['relates_to'],
		weight: 1
	}))
});

const edges = (n: number): Connections => ({
	total: n,
	edges: Array.from({ length: n }, (_, i) => ({
		edgeId: `e${i}`,
		direction: 'outgoing',
		label: 'relates_to',
		edgeKind: 'near',
		weight: 1,
		peerTable: 'kb_blobs',
		peerId: `b${String(i).padStart(8, '0')}`,
		peerTitle: null,
		created: '2026-09-27T00:00:00+00:00'
	}))
});

const HISTORY: History = {
	total: 260,
	omitted: 60,
	runs: [
		{
			actorName: 'j-cole-taylor',
			acts: 2,
			firstAt: '2026-09-26T00:00:00+00:00',
			lastAt: '2026-09-27T00:00:00+00:00',
			events: [
				{ eventId: 'ev1', kind: 'resource_reblocked', occurredAt: '2026-09-27T00:00:00+00:00' }
			]
		}
	]
};

const SOURCES: Sources = { blocks: [] };

type Answers = Partial<Record<string, () => Promise<unknown>>>;
let calls: { cmd: string; args?: Record<string, unknown> }[] = [];

function answering(answers: Answers): void {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
		calls.push({ cmd, args });
		const answer = answers[cmd];
		if (!answer) throw new Error(`unexpected command ${cmd}`);
		return answer();
	}) as never);
}

const present =
	<T>(data: T) =>
	async (): Promise<PanelRead<T>> => ({ state: 'present', data });
const DEFAULTS: Answers = {
	doc_open: async () => OPENED,
	doc_connections: present(edges(2)),
	doc_related: present(neighbours(2)),
	doc_history: present(HISTORY),
	doc_sources: present(SOURCES),
	temper_resolve_refs: async () => []
};

const panelCalls = () => calls.filter((c) => PANEL_READS.includes(c.cmd)).map((c) => c.cmd);

function button(container: HTMLElement, text: string): HTMLButtonElement {
	const found = [...container.querySelectorAll('button')].find((b) =>
		b.textContent?.includes(text)
	);
	if (!found) throw new Error(`no button "${text}"`);
	return found as HTMLButtonElement;
}

/** Open the document in a new tab and mount that tab's step host, as the shell does. */
function openRoom() {
	tabs.open({ kind: 'resource', id: ID }, { where: 'new' });
	const tab = tabs.active;
	const view = render(StepHost, { props: { tabId: tab.id, step: tabs.current(tab) } });
	return { ...view, step: () => tabs.current(tab) };
}

async function opened(container: HTMLElement): Promise<void> {
	await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe(OPENED.title));
}

describe('the document room', () => {
	beforeEach(() => {
		calls = [];
		for (const tab of [...tabs.tabs]) if (tab.id !== HOME_TAB) tabs.close(tab.id);
		answering(DEFAULTS);
	});

	it('renders body-first: properties above the body, the panel closed, nothing else read (W3)', async () => {
		const { container } = openRoom();
		await opened(container);
		await waitFor(() => expect(container.querySelector('.md-body h1')?.textContent).toBe('Scope'));

		expect(calls.map((c) => c.cmd)).toEqual(['doc_open']);
		expect(container.textContent).toContain('temper-stage');
		expect(container.textContent).toContain('in-progress');
		expect(button(container, 'About this document').getAttribute('aria-expanded')).toBe('false');
		// Closed, the panel withholds; it does not vanish.
		expect(container.textContent).toContain('read when you open them');
	});

	it('issues exactly one tab read per tab, on first open, and never again (W3)', async () => {
		const { container } = openRoom();
		await opened(container);

		await fireEvent.click(button(container, 'About this document'));
		expect(panelCalls()).toEqual(['doc_connections']);

		await fireEvent.click(button(container, 'History'));
		expect(panelCalls()).toEqual(['doc_connections', 'doc_history']);

		// Back to a tab already read, then close and reopen: no read repeats.
		await fireEvent.click(button(container, 'Connections'));
		await fireEvent.click(button(container, 'Close about this document'));
		await fireEvent.click(button(container, 'About this document'));
		expect(panelCalls()).toEqual(['doc_connections', 'doc_history']);
		expect(calls.find((c) => c.cmd === 'doc_history')?.args).toEqual({ id: ID });
	});

	it('says what each tab omits past its bound (W4)', async () => {
		answering({
			...DEFAULTS,
			doc_connections: present(edges(40)),
			doc_related: present(neighbours(30))
		});
		const { container } = openRoom();
		await opened(container);

		await fireEvent.click(button(container, 'About this document'));
		await waitFor(() => expect(container.textContent).toContain('25 of 40 connections'));
		expect(container.textContent).toContain('15 not shown');

		await fireEvent.click(button(container, 'Related'));
		await waitFor(() =>
			expect(container.textContent).toContain('25 of 30 resources one step away')
		);

		await fireEvent.click(button(container, 'History'));
		await waitFor(() =>
			expect(container.textContent).toContain(
				"200 of 260 events in this document's history, newest first; 60 not shown."
			)
		);

		await fireEvent.click(button(container, 'Sources'));
		await waitFor(() => expect(container.textContent).toContain('No recorded sources.'));
	});

	it('shows more on request, and the sentence follows what is shown (W4)', async () => {
		answering({ ...DEFAULTS, doc_connections: present(edges(40)) });
		const { container } = openRoom();
		await opened(container);
		await fireEvent.click(button(container, 'About this document'));
		await waitFor(() => expect(container.textContent).toContain('25 of 40 connections'));
		await fireEvent.click(button(container, 'Show 15 more'));
		expect(container.textContent).toContain('All 40 connections');
	});

	it('a failed tab read fails that tab alone; the body and other tabs stand (W5)', async () => {
		answering({
			...DEFAULTS,
			doc_history: async () => ({ state: 'failed', message: 'the trail read timed out' })
		});
		const { container } = openRoom();
		await opened(container);

		await fireEvent.click(button(container, 'About this document'));
		await fireEvent.click(button(container, 'History'));
		await waitFor(() =>
			expect(container.textContent).toContain('History unavailable — nothing was read.')
		);
		expect(container.textContent).toContain('the trail read timed out');
		expect(container.querySelector('h1')?.textContent).toBe(OPENED.title);
		expect(container.querySelector('.md-body')).not.toBeNull();

		await fireEvent.click(button(container, 'Connections'));
		await waitFor(() => expect(container.textContent).toContain('All 2 connections'));
		expect(container.textContent).not.toContain('History unavailable');
	});

	it('a failed tab offers to read again, and only that tab is read again', async () => {
		let attempts = 0;
		answering({
			...DEFAULTS,
			doc_history: async () =>
				++attempts === 1
					? { state: 'failed', message: 'the trail read timed out' }
					: { state: 'present', data: HISTORY }
		});
		const { container } = openRoom();
		await opened(container);
		await fireEvent.click(button(container, 'About this document'));
		await fireEvent.click(button(container, 'History'));
		await waitFor(() => expect(container.textContent).toContain('History unavailable'));

		await fireEvent.click(button(container, 'Read again'));
		await waitFor(() => expect(container.textContent).toContain('j-cole-taylor'));
		expect(panelCalls()).toEqual(['doc_connections', 'doc_history', 'doc_history']);
	});

	it('a thrown tab read is a failure in that tab, not a stuck arrival (W5)', async () => {
		answering({
			...DEFAULTS,
			doc_sources: async () => {
				throw 'temper is not connected';
			}
		});
		const { container } = openRoom();
		await opened(container);
		await fireEvent.click(button(container, 'About this document'));
		await fireEvent.click(button(container, 'Sources'));
		await waitFor(() =>
			expect(container.textContent).toContain('Recorded sources unavailable — nothing was read.')
		);
	});

	it('names its tab once it has read its title, and not before', async () => {
		let settle: (value: DocOpened) => void = () => {};
		answering({ ...DEFAULTS, doc_open: () => new Promise((resolve) => (settle = resolve)) });
		const { container, step } = openRoom();
		expect(step().title).toBeNull();
		expect(container.textContent).toContain('Loading the document…');

		settle(OPENED);
		await opened(container);
		expect(step().title).toBe(OPENED.title);
		expect(step().lens).toBe('core/document');
		expect(step().docType).toBe('task');
	});

	it('an open that fails says so and still offers the panel', async () => {
		answering({
			...DEFAULTS,
			doc_open: async () => ({ state: 'failed', id: ID, message: 'offline' })
		});
		const { container, step } = openRoom();
		await waitFor(() =>
			expect(container.textContent).toContain('This document unavailable — nothing was read.')
		);
		expect(step().title).toBeNull();
		expect(button(container, 'About this document')).toBeDefined();
	});

	it('an unresolved reference says there is nothing here, and offers nothing to read about', async () => {
		answering({
			...DEFAULTS,
			doc_open: async () => ({ state: 'unresolved', id: ID, reason: 'not found' })
		});
		const { container } = openRoom();
		await waitFor(() => expect(container.textContent).toContain('No document at this reference.'));
		expect(
			[...container.querySelectorAll('button')].some((b) => b.textContent?.includes('About'))
		).toBe(false);
	});

	it('a neighbour links by its address alone — the tab, not the link, holds the trail', async () => {
		const { container } = openRoom();
		await opened(container);
		await fireEvent.click(button(container, 'About this document'));
		await fireEvent.click(button(container, 'Related'));
		await waitFor(() => expect(container.textContent).toContain('Neighbour 0'));
		const link = [...container.querySelectorAll('a')].find((a) =>
			a.textContent?.includes('Neighbour 0')
		);
		expect(link?.getAttribute('href')).toBe('/r/01a0e2a1-34a8-7a63-8fd6-000000000000');
	});

	it('a connection to a resource links into its room; a blob stays inert', async () => {
		answering({
			...DEFAULTS,
			doc_connections: present<Connections>({
				total: 2,
				edges: [
					{ ...edges(1).edges[0], edgeId: 'r', peerTable: 'kb_resources', peerId: PEER },
					{ ...edges(1).edges[0], edgeId: 'b', direction: 'incoming' }
				]
			}),
			temper_resolve_refs: async () => [
				{
					state: 'resolved',
					id: PEER,
					title: 'The peer',
					docType: 'session',
					contextRef: null,
					decoratedRef: `the-peer-${PEER}`
				}
			]
		});
		const { container } = openRoom();
		await opened(container);
		await fireEvent.click(button(container, 'About this document'));
		await waitFor(() => expect(container.textContent).toContain('The peer'));
		const link = [...container.querySelectorAll('a')].find((a) =>
			a.textContent?.includes('The peer')
		);
		expect(link?.getAttribute('href')).toBe(`/r/the-peer-${PEER}`);
		expect(container.textContent).toContain('← relates_to');
		expect(container.textContent).toContain('blob · b0000000');
	});
});

describe("the document room's save path", () => {
	beforeEach(() => {
		calls = [];
		for (const tab of [...tabs.tabs]) if (tab.id !== HOME_TAB) tabs.close(tab.id);
		answering(DEFAULTS);
	});

	/** Open the room, enter editing, and reach the editor through its shadow root. */
	async function editing(container: HTMLElement) {
		await opened(container);
		await fireEvent.click(button(container, 'Edit'));
		const host = container.querySelector('.editor') as HTMLElement & {
			shadowRoot: ShadowRoot;
		};
		expect(host).not.toBeNull();
		await waitFor(() => expect(host.shadowRoot.querySelector('.cm-content')).not.toBeNull());
		return { host };
	}

	/** What a save was sent with, as the answering wrapper recorded it. */
	function saveArgs(): Record<string, unknown> | undefined {
		return calls.find((c) => c.cmd === 'doc_save_body')?.args;
	}

	/** Every save's args, in the order they were sent. */
	function saveCalls(): Record<string, unknown>[] {
		return calls.filter((c) => c.cmd === 'doc_save_body').map((c) => c.args ?? {}) as Record<
			string,
			unknown
		>[];
	}

	/** One byte into the draft, through the view CodeMirror itself resolves from the DOM. */
	async function typeInto(host: HTMLElement & { shadowRoot: ShadowRoot }, insert: string) {
		const content = host.shadowRoot.querySelector('.cm-content') as HTMLElement;
		const view = EditorView.findFromDOM(content);
		if (!view) throw new Error('the editor view did not resolve from the DOM');
		view.dispatch({ changes: { from: view.state.doc.length, insert } });
		await waitFor(() => {
			expect(button(host.closest('.page') as HTMLElement, 'Save').disabled).toBe(false);
		});
		return view;
	}

	it('a dirty draft saves against the opened base and lands: the base moves, the room re-reads (W2)', async () => {
		const freshOpen: Extract<DocOpened, { state: 'opened' }> = {
			...OPENED,
			markdown: '# Scope\n\nThe room, read-only.edited',
			bodyHash: 'h2'
		};
		let opens = 0;
		answering({
			...DEFAULTS,
			doc_open: async () => (opens++ === 0 ? OPENED : freshOpen),
			doc_save_body: async () => ({ state: 'saved', bodyHash: 'h2' })
		});
		const { container } = openRoom();
		const { host } = await editing(container);

		// Save is disabled while the draft is clean: a byte-identical save is never invited.
		expect(button(container, 'Save').disabled).toBe(true);
		await typeInto(host, 'edited');
		expect(button(container, 'Save').disabled).toBe(false);

		await fireEvent.click(button(container, 'Save'));
		await waitFor(() => expect(saveArgs()).toBeDefined());
		expect(saveArgs()?.id).toBe(ID);
		expect(saveArgs()?.baseHash).toBe(OPENED.bodyHash);
		expect(saveArgs()?.baseMarkdown).toBe(OPENED.markdown);
		expect(saveArgs()?.content).toBe(`${OPENED.markdown}edited`);

		// The save landed: the room re-reads, and the fresh answer is what it now renders.
		await waitFor(() => expect(container.textContent).toContain('read-only.edited'));
		// Editing closed: the properties strip is back, the editor is gone.
		expect(container.querySelector('.editor')).toBeNull();
		expect(button(container, 'Edit')).toBeDefined();
	});

	it('a byte-identical draft is never invited to save (W10, client half)', async () => {
		answering({ ...DEFAULTS });
		const { container } = openRoom();
		const { host } = await editing(container);
		await waitFor(() => expect(button(container, 'Save').disabled).toBe(true));
		// Even after an edit and an undo back to the base text, nothing is sent.
		const content = host.shadowRoot.querySelector('.cm-content') as HTMLElement;
		const view = EditorView.findFromDOM(content);
		if (!view) throw new Error('the editor view did not resolve from the DOM');
		view.dispatch({ changes: { from: view.state.doc.length, insert: 'x' } });
		await waitFor(() => expect(button(container, 'Save').disabled).toBe(false));
		view.dispatch({
			changes: { from: view.state.doc.length - 1, to: view.state.doc.length, insert: '' }
		});
		await waitFor(() => expect(button(container, 'Save').disabled).toBe(true));
		expect(calls.filter((c) => c.cmd === 'doc_save_body')).toHaveLength(0);
	});

	it('a save against a moved base lands nothing and orients: who, when, which sections (W-refusal)', async () => {
		const newer: Extract<DocOpened, { state: 'opened' }> = {
			...OPENED,
			markdown: '# Scope\n\nSomeone else changed this.',
			bodyHash: 'newer'
		};
		answering({
			...DEFAULTS,
			doc_save_body: async () => ({
				state: 'refused',
				current: newer,
				lastBodyChange: { actorName: 'someone-else', occurredAt: '2026-09-28T00:00:00+00:00' },
				changedSections: ['# Scope']
			})
		});
		const { container } = openRoom();
		const { host } = await editing(container);
		await typeInto(host, 'my edit');
		await fireEvent.click(button(container, 'Save'));

		// The refusal orients: nothing was saved, who changed it, and which sections differ.
		await waitFor(() => expect(container.textContent).toContain('changed since you opened it'));
		expect(container.textContent).toContain('someone-else');
		expect(container.textContent).toContain('# Scope');
		// The room still renders the base: nothing landed. The renderer's sanitizer loads on the
		// client, so the article can trail the refusal by a tick.
		await waitFor(() =>
			expect(container.querySelector('.md-body')?.textContent).toContain('The room, read-only.')
		);
		// The refusal took the editor's place while it stands; the draft lives in the room.
		expect(container.textContent).toContain('Keep my draft on the newer base');
	});

	it('take newer discards the draft and shows the newer version', async () => {
		const newer: Extract<DocOpened, { state: 'opened' }> = {
			...OPENED,
			markdown: '# Scope\n\nSomeone else changed this.',
			bodyHash: 'newer'
		};
		answering({
			...DEFAULTS,
			doc_save_body: async () => ({
				state: 'refused',
				current: newer,
				lastBodyChange: null,
				changedSections: ['# Scope']
			})
		});
		const { container } = openRoom();
		const { host } = await editing(container);
		await typeInto(host, 'my edit');
		await fireEvent.click(button(container, 'Save'));
		await waitFor(() => expect(container.textContent).toContain('changed since you opened it'));
		await fireEvent.click(button(container, 'Take newer'));
		await waitFor(() => expect(container.textContent).toContain('Someone else changed this.'));
		expect(container.querySelector('.editor')).toBeNull();
	});

	it('keeping the draft re-bases it on the newer hash: the next save compares against it', async () => {
		const newer: Extract<DocOpened, { state: 'opened' }> = {
			...OPENED,
			markdown: '# Scope\n\nSomeone else changed this.',
			bodyHash: 'newer'
		};
		let saves = 0;
		answering({
			...DEFAULTS,
			doc_save_body: async () => {
				saves++;
				if (saves === 1) {
					return {
						state: 'refused',
						current: newer,
						lastBodyChange: null,
						changedSections: ['# Scope']
					};
				}
				return { state: 'saved', bodyHash: 'final' };
			}
		});
		const { container } = openRoom();
		const { host } = await editing(container);
		await typeInto(host, 'my edit');
		await fireEvent.click(button(container, 'Save'));
		await waitFor(() => expect(container.textContent).toContain('changed since you opened it'));
		await fireEvent.click(button(container, 'Keep my draft on the newer base'));
		// The editor is back (remounted with the draft as its seed), the refusal is gone.
		const host2 = await waitFor(() => {
			const h = container.querySelector('.editor') as HTMLElement & { shadowRoot: ShadowRoot };
			expect(h?.shadowRoot?.querySelector('.cm-content')).not.toBeNull();
			return h;
		});
		expect(container.textContent).not.toContain('changed since you opened it');
		// The remounted editor seeds with the person's draft, not the newer base.
		const content = host2.shadowRoot.querySelector('.cm-content') as HTMLElement;
		const view = EditorView.findFromDOM(content);
		if (!view) throw new Error('the editor view did not resolve from the DOM');
		expect(view.state.doc.toString()).toBe(`${OPENED.markdown}my edit`);
		// The next save goes out against the newer base, not the opened one.
		view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } });
		await fireEvent.click(button(container, 'Save'));
		await waitFor(() => expect(saveCalls().length).toBe(2));
		expect(saveCalls()[1].baseHash).toBe('newer');
	});

	it('a dirty draft holds the tab: beforeLeave answers, and a saved draft releases it (W-draft-guard)', async () => {
		answering({
			...DEFAULTS,
			doc_save_body: async () => ({ state: 'saved', bodyHash: 'h2' })
		});
		const { container, step } = openRoom();
		const { host } = await editing(container);
		await typeInto(host, 'my edit');

		// The tab's guard is set: opening another subject here is asked. The room's guard lives on
		// the tab; the model consults it before any move. Drive the shell's own open: the guard
		// must refuse until the draft is saved, and the step must not move.
		tabs.open({ kind: 'resource', id: PEER }, { where: 'here' });
		expect(step().subject.kind).toBe('resource');
		expect(tabs.notice).toContain('unsaved draft');

		// A landed save releases the guard: save, then the same open is allowed through.
		await fireEvent.click(button(container, 'Save'));
		await waitFor(() => expect(container.querySelector('.editor')).toBeNull());
		tabs.open({ kind: 'resource', id: PEER }, { where: 'here' });
		const subject = step().subject;
		expect(subject.kind === 'resource' && subject.id).toBe(PEER);
	});
});
