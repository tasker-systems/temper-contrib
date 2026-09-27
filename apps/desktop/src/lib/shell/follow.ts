/**
 * Links stay links: in-room references are real `<a href>`s, and the shell turns a followed
 * in-app link into a move through the tab model's one door. A plain click follows in place (a new
 * step in this tab); a ⌘/Ctrl-click or a middle click opens a new tab. A place opens once: a tab
 * already showing it is focused. An address the shell does not recognise is left to the browser.
 *
 * SvelteKit's router returns early on a prevented click and ignores modified ones, so the shell
 * must catch modified clicks itself; a middle click fires `auxclick`, not `click`.
 */
import { subjectFromAddress } from './subjects';
import type { TabModel } from './tabs.svelte';

export function follow(event: MouseEvent, model: TabModel): void {
	if (event.defaultPrevented) return;
	if (event.type === 'click' && event.button !== 0) return;
	if (event.type === 'auxclick' && event.button !== 1) return;
	const anchor = (event.target as Element | null)?.closest?.('a[href]');
	if (!(anchor instanceof HTMLAnchorElement)) return;
	if (anchor.target && anchor.target !== '_self') return;
	if (anchor.hasAttribute('download')) return;
	const url = new URL(anchor.href, window.location.href);
	if (url.origin !== window.location.origin) return;
	const subject = subjectFromAddress(url.pathname, url.searchParams);
	if (!subject) return;
	event.preventDefault();
	if (subject.kind === 'place') {
		model.focusOrOpen(subject);
		return;
	}
	const newTab = event.type === 'auxclick' || event.metaKey || event.ctrlKey;
	model.open(subject, { where: newTab ? 'new' : 'here' });
}
