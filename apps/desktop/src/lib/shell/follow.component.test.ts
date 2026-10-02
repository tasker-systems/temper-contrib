import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokes: { cmd: string; args?: Record<string, unknown> }[] = [];
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
		invokes.push({ cmd, args });
		if (cmd === 'temper_connection_status') {
			return Promise.resolve({ connected: true, error: null, serverUrl: serverAnswer });
		}
		return Promise.resolve(null);
	})
}));

/** What the machine's config says the deployed server is; set per test. */
let serverAnswer: string | null = null;

import { follow, forgetServerOrigin } from './follow';
import type { TabModel } from './tabs.svelte';

type Opened = { subject: unknown; where: string };
function fakeModel(): { model: TabModel; opened: Opened[]; focused: unknown[] } {
	const opened: Opened[] = [];
	const focused: unknown[] = [];
	const model = {
		open: vi.fn((subject: unknown, opts: { where: string }) => {
			opened.push({ subject, where: opts.where });
		}),
		focusOrOpen: vi.fn((subject: unknown) => {
			focused.push(subject);
		})
	} as unknown as TabModel;
	return { model, opened, focused };
}

function clickOn(
	anchorHref: string,
	type: 'click' | 'auxclick' = 'click',
	mods = {}
): {
	event: MouseEvent;
	anchor: HTMLAnchorElement;
} {
	const anchor = document.createElement('a');
	anchor.href = anchorHref;
	anchor.textContent = 'a link';
	document.body.append(anchor);
	return { event: dispatch(type, mods, anchor).event, anchor };
}

/** An SVG anchor with a text inside it — the shape a graph's drawn mark takes. */
function svgClickOn(
	anchorHref: string,
	type: 'click' | 'auxclick' = 'click',
	mods = {}
): { event: MouseEvent; anchor: SVGAElement } {
	const anchor = document.createElementNS('http://www.w3.org/2000/svg', 'a');
	anchor.setAttribute('href', anchorHref);
	const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
	text.textContent = 'a mark';
	anchor.append(text);
	document.body.append(anchor);
	// The click lands on what was pointed at — the caption inside the anchor — and the shell
	// walks `closest` from there, exactly as a pointer would.
	return { event: dispatch(type, mods, text).event, anchor };
}

function dispatch(
	type: 'click' | 'auxclick',
	mods: Record<string, unknown>,
	on: Element
): { event: MouseEvent } {
	const init: MouseEventInit = {
		button: type === 'auxclick' ? 1 : 0,
		bubbles: true,
		cancelable: true,
		...mods
	};
	const event = new MouseEvent(type, init);
	// jsdom does not set target from dispatchEvent's init; anchor.click() would navigate.
	on.dispatchEvent(event);
	return { event };
}

describe("the shell's link follower", () => {
	beforeEach(() => {
		invokes.length = 0;
		serverAnswer = null;
		forgetServerOrigin();
		document.body.innerHTML = '';
		vi.spyOn(window, 'location', 'get').mockReturnValue({
			...window.location,
			origin: 'http://tauri.localhost',
			href: 'http://tauri.localhost/r/a-document-1'
		} as unknown as Location);
	});

	it("opens an external link in the person's browser, the webview never navigating", async () => {
		const { model, opened } = fakeModel();
		follow(clickOn('https://example.com/article').event, model);
		await vi.waitFor(() =>
			expect(invokes.some((i) => i.cmd === 'plugin:opener|open_url')).toBe(true)
		);
		expect(invokes.find((i) => i.cmd === 'plugin:opener|open_url')?.args).toEqual({
			url: 'https://example.com/article'
		});
		expect(opened).toHaveLength(0);
	});

	it("intercepts the deployed server's vault room into a tab, as the resource it names", async () => {
		serverAnswer = 'https://temperkb.io';
		const { model, opened } = fakeModel();
		const uuid = '01a0d873-59c9-72f0-a31f-23f0da5d8789';
		follow(clickOn(`https://temperkb.io/vault/r/${uuid}`).event, model);
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		expect((opened[0].subject as { kind: string; id: string }).kind).toBe('resource');
		expect((opened[0].subject as { kind: string; id: string }).id).toBe(uuid);
		expect(opened[0].where).toBe('here');
		// The browser is never asked for a tempered shape.
		expect(invokes.some((i) => i.cmd === 'plugin:opener|open_url')).toBe(false);
	});

	it('a modified click on an intercepted vault room opens a new tab', async () => {
		serverAnswer = 'https://temperkb.io';
		const { model, opened } = fakeModel();
		follow(
			clickOn('https://temperkb.io/vault/r/01a0d873-59c9-72f0-a31f-23f0da5d8789', 'click', {
				metaKey: true
			}).event,
			model
		);
		await vi.waitFor(() => expect(opened).toHaveLength(1));
		expect(opened[0].where).toBe('new');
	});

	it('a temper-shaped path on any other host is not tempered — the browser opens', async () => {
		serverAnswer = 'https://temperkb.io';
		const { model, opened } = fakeModel();
		follow(
			clickOn('https://evil.example.com/vault/r/01a0d873-59c9-72f0-a31f-23f0da5d8789').event,
			model
		);
		await vi.waitFor(() =>
			expect(invokes.some((i) => i.cmd === 'plugin:opener|open_url')).toBe(true)
		);
		expect(opened).toHaveLength(0);
	});

	it("an unconfigured machine intercepts nothing — every external link is the browser's", async () => {
		serverAnswer = null;
		const { model, opened } = fakeModel();
		follow(
			clickOn('https://temperkb.io/vault/r/01a0d873-59c9-72f0-a31f-23f0da5d8789').event,
			model
		);
		await vi.waitFor(() =>
			expect(invokes.some((i) => i.cmd === 'plugin:opener|open_url')).toBe(true)
		);
		expect(opened).toHaveLength(0);
	});

	it('the login-shell read lands once per session — a second follow does not re-ask status', async () => {
		serverAnswer = 'https://temperkb.io';
		const { model } = fakeModel();
		follow(clickOn('https://example.com/one').event, model);
		await vi.waitFor(() =>
			expect(invokes.some((i) => i.cmd === 'plugin:opener|open_url')).toBe(true)
		);
		const asksAfterFirst = invokes.filter((i) => i.cmd === 'temper_connection_status').length;
		expect(asksAfterFirst).toBe(1);
		invokes.length = 0;
		follow(clickOn('https://example.com/two').event, model);
		await vi.waitFor(() =>
			expect(invokes.some((i) => i.cmd === 'plugin:opener|open_url')).toBe(true)
		);
		expect(invokes.some((i) => i.cmd === 'temper_connection_status')).toBe(false);
	});

	it('follows a plain click on an in-app HTML anchor in place', () => {
		const { model, opened } = fakeModel();
		const uuid = '01a0d873-59c9-72f0-a31f-23f0da5d8789';
		// jsdom resolves an HTML anchor's `.href` against its own base, not the mock below, so the
		// in-app address is named in full; the app's own origin is what a real document resolves to.
		follow(clickOn(`http://tauri.localhost/r/${uuid}`).event, model);
		expect(opened).toHaveLength(1);
		expect((opened[0].subject as { kind: string; id: string }).kind).toBe('resource');
		expect((opened[0].subject as { kind: string; id: string }).id).toBe(uuid);
		expect(opened[0].where).toBe('here');
	});

	it('follows an SVG anchor in place on a plain click', () => {
		const { model, opened } = fakeModel();
		const uuid = '01a0f000-0000-7000-8000-00000000000a';
		follow(svgClickOn(`/r/${uuid}`).event, model);
		expect(opened).toHaveLength(1);
		expect((opened[0].subject as { kind: string; id: string }).kind).toBe('resource');
		expect((opened[0].subject as { kind: string; id: string }).id).toBe(uuid);
		expect(opened[0].where).toBe('here');
	});

	it('a ⌘-click on an SVG anchor opens a new tab, and a middle click too', () => {
		const { model, opened } = fakeModel();
		const uuid = '01a0f000-0000-7000-8000-00000000000a';
		follow(svgClickOn(`/r/${uuid}`, 'click', { metaKey: true }).event, model);
		follow(svgClickOn(`/r/${uuid}`, 'auxclick').event, model);
		expect(opened).toHaveLength(2);
		expect(opened.every((o) => o.where === 'new')).toBe(true);
	});

	it('an SVG anchor to a foreign origin is left to the browser, the webview never navigating', async () => {
		const { model, opened } = fakeModel();
		follow(svgClickOn('https://example.com/article').event, model);
		await vi.waitFor(() =>
			expect(invokes.some((i) => i.cmd === 'plugin:opener|open_url')).toBe(true)
		);
		expect(invokes.find((i) => i.cmd === 'plugin:opener|open_url')?.args).toEqual({
			url: 'https://example.com/article'
		});
		expect(opened).toHaveLength(0);
	});
});
