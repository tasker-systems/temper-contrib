/**
 * A document's properties as the room renders them. Ported from temper's temper-ui
 * (tasker-systems/temper, packages/temper-ui/src/lib/properties.ts and propertyValue.ts, at
 * ee12cd5) by copy-with-citation. The room reads properties only, so the port carries the
 * read half: the merge and the value classifier. The offer of state and description controls
 * belongs to metadata editing and is not carried here.
 *
 * The managed/open split is a read-time projection over one flat property store; this merges
 * it back. `managed` survives only as a presentation hint, not a storage fact.
 */

export interface PropertyRow {
	key: string;
	value: unknown;
	managed: boolean;
}

/**
 * Editorial render order for the managed run — a ranking, not the set. Which tier a key belongs
 * to is decided by the server (it arrives in `managed_meta` or `open_meta`), never by this list.
 * A managed key this list has no opinion about is still managed; it sorts after the ranked ones,
 * alphabetically.
 */
export const MANAGED_KEY_ORDER = [
	'temper-stage',
	'temper-mode',
	'temper-effort',
	'temper-status',
	'temper-seq',
	'temper-llm-model',
	'temper-llm-run',
	'temper-provenance',
	'temper-branch',
	'temper-pr'
] as const;

const MANAGED_RANK = new Map<string, number>(MANAGED_KEY_ORDER.map((k, i) => [k, i]));
const UNRANKED = MANAGED_KEY_ORDER.length;

/**
 * Both tiers merged into one ordered set: `doc_type` first, then the managed run, then open keys
 * alphabetically. Null-valued keys are dropped — the store never holds a null property value, so
 * a null here means absent, not set to nothing.
 */
export function mergeProperties(
	managed: Record<string, unknown> | null | undefined,
	open: Record<string, unknown> | null | undefined,
	docType: string
): PropertyRow[] {
	const managedRows: PropertyRow[] = [];
	const openRows: PropertyRow[] = [];

	for (const [key, value] of Object.entries(managed ?? {})) {
		if (value === null || value === undefined) continue;
		managedRows.push({ key, value, managed: true });
	}
	for (const [key, value] of Object.entries(open ?? {})) {
		if (value === null || value === undefined) continue;
		openRows.push({ key, value, managed: false });
	}

	managedRows.sort((a, b) => {
		const ra = MANAGED_RANK.get(a.key) ?? UNRANKED;
		const rb = MANAGED_RANK.get(b.key) ?? UNRANKED;
		return ra === rb ? a.key.localeCompare(b.key) : ra - rb;
	});
	openRows.sort((a, b) => a.key.localeCompare(b.key));

	return [{ key: 'doc_type', value: docType, managed: true }, ...managedRows, ...openRows];
}

/**
 * What a property value is, so the renderer can stay declarative. One key is one row: a scalar
 * renders inline; an object or array collapses to a summary and expands on demand.
 */
export type ClassifiedValue =
	| { kind: 'scalar'; text: string }
	| { kind: 'object'; entries: [string, unknown][]; summary: string }
	| { kind: 'array'; items: unknown[]; summary: string };

/** Classify one property value. Total — never throws, for any input. */
export function classifyValue(value: unknown): ClassifiedValue {
	if (value === null || value === undefined) return { kind: 'scalar', text: '—' };

	if (Array.isArray(value)) {
		if (value.length === 0) return { kind: 'scalar', text: '[]' };
		return { kind: 'array', items: value, summary: `[${value.length}]` };
	}

	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return { kind: 'scalar', text: '{}' };
		return {
			kind: 'object',
			entries,
			summary: `{${entries.length} ${entries.length === 1 ? 'key' : 'keys'}}`
		};
	}

	return { kind: 'scalar', text: String(value) };
}
