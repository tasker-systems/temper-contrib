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

/**
 * Whether two property values read as the same — deep, JSON-shaped. Total: any pair
 * answers, nothing throws. A key absent on one side never equals a present one, so a
 * removed key is always a change, never a restatement.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
	}
	if (typeof a === 'object' && typeof b === 'object') {
		const ae = Object.entries(a as object);
		const be = Object.entries(b as object);
		return (
			ae.length === be.length &&
			ae.every(([k, v]) => k in (b as object) && deepEqual(v, (b as Record<string, unknown>)[k]))
		);
	}
	return false;
}

/**
 * One tier's patch: only the keys whose value differs from what is stored, a removed
 * key sent as `null` (the API deletes an `open_meta` key on an explicit null —
 * temperkb-workflow-0.5.4 `src/types/resource.rs:335-340`), untouched keys absent —
 * the update merges at the key, so an unnamed key is never touched. A tier with no
 * change answers `null`, and a `null` patch is how "nothing changed here" travels.
 */
export function metaPatchTier(
	before: Record<string, unknown> | null | undefined,
	edited: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(edited ?? {})) {
		if (!deepEqual(before?.[key], value)) patch[key] = value;
	}
	for (const key of Object.keys(before ?? {})) {
		if (!(key in (edited ?? {}))) patch[key] = null;
	}
	return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * A property key the read path does not return as a description, and which this surface
 * must therefore never write as one. Sentences ported from temper-ui's reservedName
 * (tasker-systems/temper, packages/temper-ui/src/routes/(app)/vault/r/[ident]/+page.server.ts,
 * at ee12cd5). The `temper-` rule over-declines — an ordinary open key may legally start
 * with "temper-" — and that is the safe direction, named rather than silent.
 */
export function reservedName(name: string): string | null {
	if (name.startsWith('temper-')) {
		return `"${name}" is a name the system owns — descriptions cannot start with "temper-".`;
	}
	if (name === 'doc_type') {
		return '"doc_type" is this resource\'s kind, not a description of it.';
	}
	if (name === 'facet') {
		return '"facet" is a name the system owns.';
	}
	return null;
}

/**
 * The JSON type a description's stored value has, when this surface can edit it
 * faithfully. Ported from temper-ui's descriptions.ts (tasker-systems/temper,
 * packages/temper-ui/src/lib/descriptions.ts, at ee12cd5) by copy-with-citation.
 * `null` offers nothing: the value is a list, an object, or absent — excluded by
 * decision, because raw JSON would ask the reader to hold the system's own vocabulary.
 */
export type EditableKind = 'string' | 'number' | 'boolean';

export function editableKind(value: unknown): EditableKind | null {
	if (typeof value === 'string') return 'string';
	if (typeof value === 'number' && Number.isFinite(value)) return 'number';
	if (typeof value === 'boolean') return 'boolean';
	return null;
}

/**
 * Turn the text a reader typed into the value to send, keeping the type the description
 * already had — a revision of `priority: 3` must not silently store `"3"`. Text that no
 * longer fits falls back to a string: retyping `3` as `three` is a legitimate revision.
 */
export function revisedValue(text: string, kind: EditableKind): string | number | boolean {
	if (kind === 'number') {
		const n = Number(text);
		return text.trim() !== '' && Number.isFinite(n) ? n : text;
	}
	if (kind === 'boolean') {
		if (text === 'true') return true;
		if (text === 'false') return false;
	}
	return text;
}

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
