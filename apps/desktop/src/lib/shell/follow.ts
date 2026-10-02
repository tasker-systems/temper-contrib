/**
 * Links stay links: in-room references are real `<a href>`s, and the shell turns a followed
 * in-app link into a move through the tab model's one door. A plain click follows in place (a
 * new step in this tab); a ⌘/Ctrl-click or a middle click opens a new tab. A place opens once: a
 * tab already showing it is focused. An address the shell does not recognise is left to the
 * browser — the person's browser, never the webview: navigating the webview would hard-refresh
 * the app and kill any live agent session riding along.
 *
 * The one intercept beyond core's own addresses: a temper-shaped vault URL on the deployed
 * server's host (`/vault/r/<uuid>`) is read back into a resource subject and opened as the
 * resource it names, same-session semantics as any in-app link. Any other host is not tempered —
 * interception is a config read (`temper_connection_status`'s `serverUrl`), never a hardcoded
 * word; a link the person cannot read returns temper's own refusal, and the desktop only
 * proposes the door.
 *
 * SvelteKit's router returns early on a prevented click and ignores modified ones, so the shell
 * must catch modified clicks itself; a middle click fires `auxclick`, not `click`.
 */
import { invoke } from '@tauri-apps/api/core';
import { subjectFromAddress } from './subjects';
import type { TabModel } from './tabs.svelte';

/** The vault-resource path a deployed temper serves — the shape one intercept reads back. */
const VAULT_ROOM = /^\/vault\/r\/([^/]+)\/?$/;

/**
 * What should open in the person's browser instead of the webview, asked once per follow and
 * held for the session: the deployed server's address from the machine's config. `null` means
 * unasked or none — interception is then inert, and the honest arm (the browser) stands.
 */
let serverOrigin: string | null | undefined;

/** TEST HOOK: clears the held server read, so a suite can re-ask per test. */
export function forgetServerOrigin(): void {
	serverOrigin = undefined;
}

async function currentServerOrigin(): Promise<string | null> {
	if (serverOrigin !== undefined) return serverOrigin;
	try {
		const status = await invoke<{ serverUrl?: string | null }>('temper_connection_status');
		const url = status.serverUrl?.trim();
		serverOrigin = url ? new URL(url).origin : null;
	} catch {
		serverOrigin = null;
	}
	return serverOrigin;
}

export function follow(event: MouseEvent, model: TabModel): void {
	if (event.defaultPrevented) return;
	if (event.type === 'click' && event.button !== 0) return;
	if (event.type === 'auxclick' && event.button !== 1) return;
	const anchor = (event.target as Element | null)?.closest?.('a[href]');
	if (!anchor) return;
	// An anchor in the SVG namespace is not an HTMLAnchorElement, and its href and target are
	// SVGAnimatedString — the HTML reads misfire — so it is read as attributes, which say the
	// same thing. Every other anchor is the HTML one, read as it always was.
	const svg = anchor.namespaceURI === 'http://www.w3.org/2000/svg';
	const target = svg ? anchor.getAttribute('target') : (anchor as HTMLAnchorElement).target;
	if (target && target !== '_self') return;
	if (anchor.hasAttribute('download')) return;
	const href = svg ? anchor.getAttribute('href') : (anchor as HTMLAnchorElement).href;
	if (!href) return;
	const url = new URL(href, window.location.href);
	if (url.origin !== window.location.origin) {
		// Refused before anything awaits: the webview must never navigate, and a preventDefault
		// that waits on the server read can lose that race.
		event.preventDefault();
		void followExternal(event, url, model);
		return;
	}
	const subject = subjectFromAddress(url.pathname, url.searchParams);
	if (!subject) {
		void openInBrowser(event, url);
		return;
	}
	event.preventDefault();
	if (subject.kind === 'place') {
		model.focusOrOpen(subject);
		return;
	}
	const newTab = event.type === 'auxclick' || event.metaKey || event.ctrlKey;
	model.open(subject, { where: newTab ? 'new' : 'here' });
}

/**
 * A different-origin address: the deployed server's vault room is intercepted
 * into a tab; anything else — including a temper-shaped path that names no
 * server we know — opens in the person's configured browser, and the webview
 * never navigates.
 */
async function followExternal(event: MouseEvent, url: URL, model: TabModel): Promise<void> {
	const origin = await currentServerOrigin();
	if (origin === url.origin) {
		const room = url.pathname.match(VAULT_ROOM);
		if (room) {
			const subject = subjectFromAddress(`/r/${room[1]}`, url.searchParams);
			if (subject) {
				event.preventDefault();
				const newTab = event.type === 'auxclick' || event.metaKey || event.ctrlKey;
				model.open(subject, { where: newTab ? 'new' : 'here' });
				return;
			}
		}
	}
	await openInBrowser(event, url);
}

/** Hands the address to the system, through the opener plugin's browser scope. */
async function openInBrowser(event: MouseEvent, url: URL): Promise<void> {
	event.preventDefault();
	try {
		await invoke('plugin:opener|open_url', { url: url.href });
	} catch (e) {
		// The opener refused. The click is already prevented (a webview
		// navigation would kill a live session), so the address is spoken
		// where the person can still use it — the browser's own bar — named
		// as the failure it is, never swallowed into silence.
		console.error(`the desktop could not open ${url.href} in a browser: ${String(e)}`);
	}
}
