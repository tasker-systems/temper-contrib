/**
 * The document room's model: the shapes its core commands answer with, and the walk that
 * carries a person from room to room.
 *
 * The walk lives in the URL, not in memory. A room entered from another room carries where it
 * was entered from, so the way out returns there, and that room's way out returns to the one
 * before. A room entered directly carries no walk, and its way out is home. Discarding every
 * local store loses nothing: the address is the whole state.
 */

// ─── Wire shapes (src-tauri/src/document.rs, document_panel.rs) ────────────────────────────────

export type DocOpened =
	| {
			state: 'opened';
			id: string;
			title: string;
			docType: string;
			contextRef: string | null;
			decoratedRef: string;
			ownerHandle: string;
			created: string;
			updated: string;
			managedMeta: Record<string, unknown> | null;
			openMeta: Record<string, unknown> | null;
			markdown: string;
			bodyHash: string;
	  }
	| { state: 'unresolved'; id: string; reason: string }
	| { state: 'failed'; id: string; message: string };

export type PanelRead<T> =
	| { state: 'present'; data: T }
	| { state: 'unresolved'; reason: string }
	| { state: 'failed'; message: string };

export interface Connection {
	edgeId: string;
	direction: 'outgoing' | 'incoming' | string;
	label: string;
	edgeKind: string;
	weight: number;
	peerTable: string;
	peerId: string;
	peerTitle: string | null;
	created: string;
}

export interface Connections {
	total: number;
	edges: Connection[];
}

export interface Neighbour {
	id: string;
	title: string;
	docType: string | null;
	excerpt: string | null;
	degree: number;
	via: string[];
	weight: number;
}

export interface Related {
	total: number;
	neighbours: Neighbour[];
}

export interface HistoryEvent {
	eventId: string;
	kind: string;
	occurredAt: string;
}

export interface HistoryRun {
	actorName: string;
	acts: number;
	firstAt: string;
	lastAt: string;
	events: HistoryEvent[];
}

export interface History {
	total: number;
	omitted: number;
	runs: HistoryRun[];
}

export interface Source {
	kind: string;
	sourceId: string;
	uri: string | null;
	carried: boolean;
}

export interface BlockSources {
	blockSeq: number;
	sources: Source[];
}

export interface Sources {
	blocks: BlockSources[];
}

/** The panel's tabs, in the order they sit, each named by the read it makes. */
export const PANEL_TABS = [
	{ key: 'connections', label: 'Connections', command: 'doc_connections' },
	{ key: 'related', label: 'Related', command: 'doc_related' },
	{ key: 'history', label: 'History', command: 'doc_history' },
	{ key: 'sources', label: 'Sources', command: 'doc_sources' }
] as const;

export type PanelTab = (typeof PANEL_TABS)[number]['key'];

// ─── The walk ──────────────────────────────────────────────────────────────────────────────────

/** How many rooms back the way out remembers. Older steps drop off the front of the walk. */
export const WALK_BOUND = 20;

const UUID_TAIL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The UUID a reference names: a bare UUID, or the tail of a decorated `slug-<uuid>`. */
export function refId(ref: string): string | null {
	return ref.trim().match(UUID_TAIL)?.[0].toLowerCase() ?? null;
}

/** The walk a room's address carries: the rooms it was entered through, oldest first. */
export function parseWalk(raw: string | null): string[] {
	if (!raw) return [];
	return raw
		.split(',')
		.map((step) => refId(step))
		.filter((id): id is string => id !== null)
		.slice(-WALK_BOUND);
}

/** The address of a room. With a walk, the room remembers where it was entered from. */
export function roomHref(target: string, walk: readonly string[] = []): string {
	const steps = walk.slice(-WALK_BOUND);
	const base = `/r/${encodeURIComponent(target)}`;
	return steps.length ? `${base}?walk=${steps.join(',')}` : base;
}

/** The address of a room entered from `current`, which itself was entered through `walk`. */
export function walkOn(target: string, current: string, walk: readonly string[]): string {
	const here = refId(current);
	return roomHref(target, here ? [...walk, here] : walk);
}

/** Where a room's way out leads: back one step along the walk, or home when there is none. */
export function wayOutOf(walk: readonly string[]): { href: string; label: string } {
	if (walk.length === 0) return { href: '/', label: 'home' };
	return { href: roomHref(walk[walk.length - 1], walk.slice(0, -1)), label: 'back' };
}

/** How many rows a panel tab shows at first, and how many more each "show more" adds. */
export const PANEL_STEP = 25;
