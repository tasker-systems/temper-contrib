/**
 * The document room's model: the shapes its core commands answer with, and the address a link
 * into a room carries. Where a room was entered from is the tab's trail (`$lib/shell/tabs`).
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

// ─── Addresses ─────────────────────────────────────────────────────────────────────────────────

const UUID_TAIL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The UUID a reference names: a bare UUID, or the tail of a decorated `slug-<uuid>`. */
export function refId(ref: string): string | null {
	return ref.trim().match(UUID_TAIL)?.[0].toLowerCase() ?? null;
}

/**
 * The address of a document's room. It names only its target: where the link was followed from
 * belongs to the tab's own trail, never to the link.
 */
export function roomHref(target: string): string {
	return `/r/${encodeURIComponent(target)}`;
}

/** How many rows a panel tab shows at first, and how many more each "show more" adds. */
export const PANEL_STEP = 25;
