/**
 * The document room's return position: where the person was in the body, kept on this device
 * and nowhere else (ruling Q2). Nothing in temper is written here — the position is a device
 * fact, so discarding webview storage discards it, while the hub's `desktop-recent-work`
 * entry survives the discard and keeps "Return to …" naming the resource (W7).
 *
 * The position is an anchor plus a fraction, not a pixel offset: headings survive reflow
 * between visits, pixels do not. The anchor is the nearest heading the person had scrolled
 * past; the fraction is how far through that section they were. Restoring seeks the anchor
 * and adds the fraction of its section; a heading the saved position names that the body no
 * longer holds is the room's sentence to say, and the room starts at the top instead.
 *
 * The store is deliberately bounded: the last places the person was, nothing more. A store
 * that cannot be read or written is silent — a failed record never fails the room it
 * decorates.
 */

/** The stored key, versioned like the other device stores. */
const STORE_KEY = 'temper-document-scroll-v1';

/** How many places of work the store remembers. Older ones drop off the end. */
export const POSITION_BOUND = 50;

/**
 * A position in a document: the heading the person had last scrolled to (the heading line as
 * the markdown writes it, e.g. `## Next: the home view`), and how far through that heading's
 * section they had read, 0–1. `heading` is `null` for the preamble — the text before the first
 * heading, or a document with none.
 */
export interface Position {
	heading: string | null;
	fraction: number;
}

/**
 * One heading the body renders: its text (as the rendered heading reads — the `##` marks are
 * syntax, not content), the ordinal it holds among headings of the same text, and its top
 * inside the scrollable body. `MarkdownRenderer` renders every heading the source names; a
 * repeated heading is distinguished by its order among its equals, which is what temper's
 * section keys do too. `top` is measured against the same box the room scrolls, so capture
 * and restore ask in one coordinate space.
 */
export interface HeadingOccurrence {
	text: string;
	index: number;
	top: number;
}

/**
 * The headings a rendered body holds, as the room's `md-body` writes them: `h1`–`h6` in
 * document order. Repeated headings stay distinct by their ordinal among their equals.
 */
export function headingOccurrences(container: HTMLElement, box: HTMLElement): HeadingOccurrence[] {
	const all = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')];
	const seen = new Map<string, number>();
	return all.map((heading) => {
		const text = (heading.textContent ?? '').trim();
		const index = seen.get(text) ?? 0;
		seen.set(text, index + 1);
		return { text, index, top: headingTop(heading as HTMLElement, box) };
	});
}

/** A heading's top inside the box the room scrolls: its rendered offset, not its document one. */
function headingTop(heading: HTMLElement, box: HTMLElement): number {
	return (heading as HTMLElement & { offsetTop: number }).offsetTop - box.offsetTop;
}

/**
 * The heading anchors a markdown source carries: the rendered text of every heading, in
 * document order, with each one's ordinal among its equals. Read from the source, not the
 * DOM, so it is a reactive input the room's restore effect can ask — the rendered body fills
 * asynchronously (the sanitizer is a dynamic import), and an effect that waits on the DOM
 * would run once against an empty body and never again. A heading-looking line inside a code
 * fence is not a heading, as temper's own rule holds.
 */
export function sourceHeadings(markdown: string): { text: string; index: number }[] {
	const headings: { text: string; index: number }[] = [];
	const seen = new Map<string, number>();
	let fence = false;
	for (const line of markdown.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		const match = fence ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		const text = match[2];
		const index = seen.get(text) ?? 0;
		seen.set(text, index + 1);
		headings.push({ text, index });
	}
	return headings;
}

/**
 * The heading the viewport top has last passed, as a saved anchor: its markdown text and the
 * fraction through its section. `headings` are the body's rendered headings in document order;
 * `scrollTop` is where the room's body is scrolled to. A top above the first heading reads the
 * preamble (`heading: null`, `fraction: 0`). The fraction is clamped inside 0–1.
 */
export function capture(
	headings: HeadingOccurrence[],
	scrollTop: number,
	scrollHeight: number
): Position {
	let chosen = -1;
	let nextIndex = headings.length;
	for (let i = 0; i < headings.length; i++) {
		if (headings[i].top <= scrollTop) {
			chosen = i;
		} else {
			nextIndex = i;
			break;
		}
	}
	if (chosen < 0) return { heading: null, fraction: 0 };
	// The fraction through the chosen section: 0 at its heading, 1 at the next (or, past the
	// last heading, the bottom of the document).
	const sectionEnd = nextIndex < headings.length ? headings[nextIndex].top : scrollHeight;
	const span = Math.max(1, sectionEnd - headings[chosen].top);
	const through = Math.max(0, Math.min(1, (scrollTop - headings[chosen].top) / span));
	return { heading: anchorFor(headings[chosen]), fraction: through };
}

/** The anchor a heading occurrence is stored under: its text, always with its ordinal. */
function anchorFor(heading: HeadingOccurrence): string {
	return `${heading.text}#${heading.index}`;
}

/**
 * The heading text an anchor names, without its ordinal. Ordinals are always appended by
 * `capture`, so the tail is stripped whenever it reads as one; a heading whose own text ends
 * in `#2` still round-trips — its anchor ends `#2#1`, and the last tail is the ordinal.
 */
export function anchorText(anchor: string): string {
	const at = anchor.lastIndexOf('#');
	if (at < 1) return anchor;
	const index = Number(anchor.slice(at + 1));
	return Number.isInteger(index) && index >= 0 ? anchor.slice(0, at) : anchor;
}

/** The ordinal an anchor names — its position among headings of the same text. */
export function anchorIndex(anchor: string): number {
	const at = anchor.lastIndexOf('#');
	if (at < 1) return 0;
	const index = Number(anchor.slice(at + 1));
	return Number.isInteger(index) && index >= 0 ? index : 0;
}

/**
 * Whether a source still holds the heading an anchor names, at its ordinal: the verdict the
 * restore effect asks reactively, before any scroll is sought. The ordinal survives when the
 * heading remains but its equals shifted; when the heading is gone, the room says so.
 */
export function anchorExists(anchor: string, markdown: string): boolean {
	const text = anchorText(anchor);
	return sourceHeadings(markdown).some((h) => h.text === text && h.index === anchorIndex(anchor));
}

/**
 * Where a saved position asks the body to be: the anchor heading's top, plus its fraction of
 * the section the heading opens, clamped to what the body can scroll. `anchor` is the anchor
 * `capture` saved; `headings` are the body's rendered headings. `null` when the body no longer
 * holds the anchor — the room says so instead of guessing.
 */
export function restoreTop(
	anchor: string,
	fraction: number,
	headings: HeadingOccurrence[],
	scrollHeight: number,
	clientHeight: number
): number | null {
	const text = anchorText(anchor);
	const wanted = headings.filter((h) => h.text === text);
	const heading = wanted[anchorIndex(anchor)] ?? wanted[0] ?? null;
	if (!heading) return null;
	const at = headings.indexOf(heading);
	// The next heading closes the section — a deeper one too, so a subsection's heading bounds
	// the fraction the same way temper's section cut does.
	const nextIndex = at + 1;
	const sectionBottom =
		nextIndex < headings.length
			? headings[nextIndex].top
			: Math.max(scrollHeight, heading.top + clientHeight);
	const span = Math.max(1, sectionBottom - heading.top);
	const usable = Math.max(1, scrollHeight - clientHeight);
	const target = heading.top + Math.max(0, Math.min(1, fraction)) * span;
	return Math.max(0, Math.min(usable, target));
}

/** The store, as a device holds it: resource id → position. */
type Store = Record<string, { heading: string | null; fraction: number }>;

function readStore(storage: Storage | null): Store {
	if (!storage) return {};
	try {
		const raw = storage.getItem(STORE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Store;
		if (!parsed || typeof parsed !== 'object') return {};
		return parsed;
	} catch {
		// What was stored is not a position table: none of it restores.
		return {};
	}
}

/** Saves one resource's position, bounded: the newest place of work, older ones dropping off. */
export function savePosition(storage: Storage | null, resource: string, position: Position): void {
	const store = readStore(storage);
	store[resource] = position;
	const keys = Object.keys(store);
	if (keys.length > POSITION_BOUND) {
		for (const key of keys.slice(0, keys.length - POSITION_BOUND)) delete store[key];
	}
	try {
		storage?.setItem(STORE_KEY, JSON.stringify(store));
	} catch {
		// A store that cannot be written does not fail the move it records.
	}
}

/** Reads one resource's saved position, or `null` when this device holds none. */
export function readPosition(storage: Storage | null, resource: string): Position | null {
	const store = readStore(storage);
	const saved = store[resource];
	if (!saved) return null;
	const fraction =
		typeof saved.fraction === 'number' && Number.isFinite(saved.fraction)
			? Math.max(0, Math.min(1, saved.fraction))
			: 0;
	return { heading: typeof saved.heading === 'string' ? saved.heading : null, fraction };
}

/** Forgets one resource's position — the room re-reads its document and the anchor may be gone. */
export function clearPosition(storage: Storage | null, resource: string): void {
	const store = readStore(storage);
	delete store[resource];
	try {
		storage?.setItem(STORE_KEY, JSON.stringify(store));
	} catch {
		// A store that cannot be written does not fail the clear it records.
	}
}

/** Test seam: the store's own key, so a witness can name what it clears. */
export const SCROLL_STORE_KEY = STORE_KEY;
