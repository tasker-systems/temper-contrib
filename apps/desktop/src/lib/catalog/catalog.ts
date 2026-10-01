/**
 * The `temper` catalog: `temper.catalog.json` is the single source. Its props are JSON Schema so
 * the same file serves the renderer here and any headless surface; they become zod here through
 * `z.fromJSONSchema`, which keeps `required` and `additionalProperties: false`.
 */
import { defineCatalog, type Spec } from '@json-render/core';
// The schema subpath, not the package root: the root re-exports Svelte components, and the gate
// must load headless too (the running-app witness runs it under bun).
import { schema } from '@json-render/svelte/schema';
import { z } from 'zod';
import source from './temper.catalog.json';

type Source = {
	limits: { maxElements: number; maxDepth: number; maxNameLength: number };
	components: Record<
		string,
		{
			description: string;
			slots: string[];
			example?: unknown;
			props: Record<string, unknown>;
			checks?: Check[];
			actions?: Record<string, { description: string; params: unknown }>;
		}
	>;
};

/**
 * What a component's props must satisfy beyond JSON Schema, declared beside them in the catalog
 * file so the core's check reads the same declaration. A path walks the props (`*` steps into
 * every item of a list); `$children` is the element's children.
 * - `count`: the items at the path are never more than the `within` prop says the view stands
 *   for; with `equals`, the prop that says how many are shown agrees with how many there are.
 * - `unique`: no value at the path repeats.
 * - `keys`: every key of every object at the path is one of the values at `in`.
 * - `values`: every value at the path is one of the values at `in` (an edge names a node that
 *   exists).
 * - `page`: the page prop agrees with the rows and the total — no more rows than a page holds,
 *   none past the total, and `more` exactly when rows follow this page.
 * - `children`: the element's children are only these types, between `min` and `max` of them.
 * - `drawn`: what a graph says it drew agrees with what it carries — the bounds' `drawn` count is
 *   the nodes carried when nothing was cut, and a cut draws to its bounds, never short of them.
 */
export type Check =
	| { count: string; within: string; equals?: string }
	| { unique: string }
	| { keys: string; in: string }
	| { values: string; in: string }
	| { page: string; rows: string; within: string }
	| { children: string[]; min: number; max: number }
	| { drawn: string; cut: string; nodes: string; nodesAt: number; edges: string; edgesAt: number };

// fromJSONSchema accepts the JSON Schema object; the cast narrows our JSON import's type.
const propsSchemas: Record<string, z.ZodType> = Object.fromEntries(
	Object.entries((source as Source).components).map(([name, c]) => [
		name,
		z.fromJSONSchema(c.props as Parameters<typeof z.fromJSONSchema>[0])
	])
);

const components = Object.fromEntries(
	Object.entries((source as Source).components).map(([name, c]) => [
		name,
		{ props: propsSchemas[name], slots: c.slots, description: c.description, example: c.example }
	])
);

// json-render's own actions stay empty: a spec cannot bind one (`on` is refused at the door), so
// its built-in state writes are unreachable. A component's view actions are declared beside its
// props and routed to the host instead (`view-actions.ts`).
export const temperCatalog = defineCatalog(schema, { components, actions: {} });

/**
 * The view actions each component declares, with the schema their params must satisfy: what a
 * host may handle (page, sort), never a write. Keyed `Component.action`.
 */
export const VIEW_ACTIONS: ReadonlyMap<string, z.ZodType> = new Map(
	Object.entries((source as Source).components).flatMap(([name, c]) =>
		Object.entries(c.actions ?? {}).map(([action, a]) => [
			`${name}.${action}`,
			z.fromJSONSchema(a.params as Parameters<typeof z.fromJSONSchema>[0])
		])
	)
);

export const CATALOG_VERSION = `temper@${(source as { version: string }).version}`;

export type SpecCheck = { ok: true; spec: Spec } | { ok: false; errors: string[] };

/** The most elements, the deepest nesting, and the longest element name a view may
 *  carry — read from the catalog file, which the core's own check reads too. A view is a bounded
 *  glance, not a document: a spec past any bound is refused, never rendered slowly. */
export const MAX_ELEMENTS = (source as Source).limits.maxElements;
export const MAX_DEPTH = (source as Source).limits.maxDepth;
export const MAX_NAME_LENGTH = (source as Source).limits.maxNameLength;

/** A name's length as JSON Schema's `maxLength` counts it: in code points, not UTF-16 units. */
const nameLength = (name: string): number => [...name].length;

const SPEC_KEYS = new Set(['root', 'elements']);
const ELEMENT_KEYS = new Set(['type', 'props', 'children']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: object, key: string): boolean => Object.hasOwn(o, key);

/**
 * What the shape must be before any component is consulted. A spec is an agent's untrusted
 * input, so the shape is closed to exactly what temper@1 renders — `root` and `elements`; per
 * element `type`, `props`, `children` — which refuses bindings, handlers, visibility and state at
 * the door (`on`, `visible`, `watch`, `repeat`, a top-level `state`: json-render acts on each).
 * Every lookup is an own-key lookup, so nothing is satisfied by `Object.prototype`. And the
 * elements form one tree from `root`: each element reached exactly once, none unreachable, no
 * cycle, within the bounds — a cycle or a shared child multiplies a render without limit.
 */
function shapeErrors(spec: unknown): string[] {
	if (!isRecord(spec)) return ['<root>: a spec is an object'];
	const errors: string[] = [];
	for (const key of Object.keys(spec))
		if (!SPEC_KEYS.has(key)) errors.push(`<root>: "${key}" is not part of a temper@1 spec`);
	const elements = spec.elements;
	if (!isRecord(elements)) return [...errors, 'elements: a spec names its elements'];
	const keys = Object.keys(elements);
	if (keys.length > MAX_ELEMENTS)
		return [...errors, `elements: ${keys.length} elements, more than ${MAX_ELEMENTS}`];
	// A name past the bound is not echoed back: the refusal would carry it whole.
	if (keys.some((key) => nameLength(key) > MAX_NAME_LENGTH))
		errors.push(`elements: a name longer than ${MAX_NAME_LENGTH} characters`);
	if (typeof spec.root === 'string' && nameLength(spec.root) > MAX_NAME_LENGTH)
		errors.push(`root: longer than ${MAX_NAME_LENGTH} characters`);
	for (const key of keys) {
		if (RESERVED_KEYS.has(key)) errors.push(`elements/${key}: a reserved name`);
		const el = elements[key];
		if (!isRecord(el)) {
			errors.push(`elements/${key}: an element is an object`);
			continue;
		}
		for (const field of Object.keys(el))
			if (!ELEMENT_KEYS.has(field))
				errors.push(`elements/${key}: "${field}" is not part of a temper@1 element`);
		if (el.children !== undefined && !Array.isArray(el.children))
			errors.push(`elements/${key}/children: a list of element names`);
	}
	const root = spec.root;
	if (typeof root !== 'string' || !has(elements, root)) {
		errors.push(`root: "${String(root)}" is not an element`);
		return errors;
	}
	// One tree from root: walked once, each element reached at most once.
	const reached = new Set<string>([root]);
	const walk = (key: string, depth: number): void => {
		if (depth > MAX_DEPTH) {
			errors.push(`elements/${key}: nested deeper than ${MAX_DEPTH}`);
			return;
		}
		const el = elements[key];
		const children = isRecord(el) && Array.isArray(el.children) ? el.children : [];
		for (const child of children) {
			if (typeof child !== 'string' || !has(elements, child)) {
				errors.push(`elements/${key}: names a child "${String(child)}" that does not exist`);
				continue;
			}
			if (reached.has(child)) {
				errors.push(`elements/${key}: "${child}" is already placed — a view is a tree`);
				continue;
			}
			reached.add(child);
			walk(child, depth + 1);
		}
	};
	walk(root, 1);
	for (const key of keys)
		if (!reached.has(key)) errors.push(`elements/${key}: not reachable from root`);
	return errors;
}

/** The values a check's path names, from an element's props (or its children, for `$children`). */
function walk(
	el: Record<string, unknown>,
	props: Record<string, unknown>,
	path: string
): unknown[] {
	const [head, ...rest] = path.split('/');
	let at: unknown[] = head === '$children' ? [el.children ?? []] : [props[head]];
	for (const step of rest)
		at = at.flatMap((v) =>
			step === '*' ? (Array.isArray(v) ? v : []) : isRecord(v) && has(v, step) ? [v[step]] : []
		);
	return at.filter((v) => v !== undefined);
}

/** A count prop's value; the schema has already made it a non-negative integer. */
const countOf = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * Every declared check an element fails (`Check`). Run after the props pass their schema, so
 * each path's values have the types the schema gives them.
 */
function declaredErrors(
	key: string,
	el: Record<string, unknown>,
	props: Record<string, unknown>,
	checks: Check[],
	elements: Record<string, unknown>
): string[] {
	const errors: string[] = [];
	for (const check of checks) {
		if ('count' in check) {
			const items = walk(el, props, check.count).reduce<number>(
				(n, v) => n + (Array.isArray(v) ? v.length : 0),
				0
			);
			const total = countOf(props[check.within]);
			if (total === null) continue;
			if (check.equals === undefined) {
				if (items > total) errors.push(`elements/${key}: shows ${items} of ${total}`);
				continue;
			}
			const shown = countOf(props[check.equals]);
			if (shown === null) continue;
			if (shown > total) errors.push(`elements/${key}: shows ${shown} of ${total}`);
			if (props.state === 'present' && items !== shown)
				errors.push(`elements/${key}: says it shows ${shown} but has ${items} rows`);
		} else if ('unique' in check) {
			const seen = new Set<unknown>();
			for (const v of walk(el, props, check.unique)) {
				if (seen.has(v))
					errors.push(`elements/${key}/props/${check.unique}: "${String(v)}" appears twice`);
				seen.add(v);
			}
		} else if ('keys' in check) {
			const allowed = new Set(walk(el, props, check.in));
			for (const obj of walk(el, props, check.keys)) {
				if (!isRecord(obj)) continue;
				for (const k of Object.keys(obj))
					if (!allowed.has(k))
						errors.push(`elements/${key}/props/${check.keys}: "${k}" is not one of ${check.in}`);
			}
		} else if ('page' in check) {
			const page = props[check.page];
			const total = countOf(props[check.within]);
			const rows = props[check.rows];
			if (!isRecord(page) || total === null || !Array.isArray(rows)) continue;
			if (props.state !== 'present') continue;
			const offset = countOf(page.offset) ?? 0;
			const size = countOf(page.size) ?? 0;
			const n = rows.length;
			if (n > size) errors.push(`elements/${key}: shows ${n} rows on a page of ${size}`);
			if (offset + n > total)
				errors.push(`elements/${key}: rows ${offset + 1} to ${offset + n} pass the total ${total}`);
			if (page.more !== offset + n < total)
				errors.push(
					`elements/${key}/props/${check.page}/more: says ${String(page.more)}, but ${offset + n} of ${total} reach this page`
				);
		} else if ('values' in check) {
			const allowed = new Set(walk(el, props, check.in));
			for (const v of walk(el, props, check.values))
				if (!allowed.has(v))
					errors.push(
						`elements/${key}/props/${check.values}: "${String(v)}" is not one of ${check.in}`
					);
		} else if ('drawn' in check) {
			if (props.state !== 'present') continue;
			const nodes = props[check.nodes];
			const edges = props[check.edges];
			const cut = props[check.cut];
			if (cut === undefined) {
				const bounds = props[check.drawn];
				const drawn = isRecord(bounds) ? countOf(bounds.drawn) : null;
				if (drawn !== null && Array.isArray(nodes) && drawn !== nodes.length)
					errors.push(`elements/${key}: says it draws ${drawn} but carries ${nodes.length} nodes`);
				continue;
			}
			if (!isRecord(cut)) continue;
			if (has(cut, 'nodes') && Array.isArray(nodes) && nodes.length !== check.nodesAt)
				errors.push(`elements/${key}: cut draws ${nodes.length} of ${check.nodesAt} nodes`);
			if (has(cut, 'edges') && Array.isArray(edges) && edges.length !== check.edgesAt)
				errors.push(`elements/${key}: cut draws ${edges.length} of ${check.edgesAt} edges`);
		} else {
			const children = Array.isArray(el.children) ? el.children : [];
			if (children.length < check.min || children.length > check.max)
				errors.push(
					`elements/${key}: holds ${children.length} children, not ${check.min} to ${check.max}`
				);
			for (const child of children) {
				const node = typeof child === 'string' && has(elements, child) ? elements[child] : null;
				const type = isRecord(node) && typeof node.type === 'string' ? node.type : undefined;
				if (type !== undefined && !check.children.includes(type))
					errors.push(`elements/${key}: holds a ${type}, but only ${check.children.join(', ')}`);
			}
		}
	}
	return errors;
}

/**
 * Validates a spec against the catalog. This is the gate — `temperCatalog.validate` alone is not:
 * json-render validates the spec's structure and component names, but with more than one
 * component it validates every element's props as an open record (`propsOf` is lenient by design,
 * since the type decides which props apply). So each element's props are checked here against
 * its own component's schema — which is what refuses an omitted `total` or a colour prop.
 *
 * Props are literal in temper@1: a `{ "$state": … }` binding does not satisfy a component's
 * schema and is refused. Admitting dynamic props is a catalog-version decision, not a default.
 *
 * The shape is closed and must be one bounded tree (`shapeErrors`); then what JSON Schema cannot
 * say, as each component declares it (`Check`): a bounded view never carries more than it stands
 * for, a table's rows are keyed by its columns, a graph's edges name its nodes, Tabs hold only
 * Sections.
 */
export function checkSpec(spec: unknown): SpecCheck {
	const errors = shapeErrors(spec);
	const result = temperCatalog.validate(spec);
	if (!result.success) {
		const issues = result.error?.issues ?? [];
		errors.push(
			...(issues.length
				? issues.map((i) => `${i.path.join('/') || '<root>'}: ${i.message}`)
				: ['spec does not match the catalog'])
		);
	}
	// Keep going where the shape allows it, so a refusal lists every reason, not the first.
	const elements = isRecord(spec) && isRecord(spec.elements) ? spec.elements : null;
	if (!elements) return { ok: false, errors: [...new Set(errors)] };

	for (const [key, el] of Object.entries(elements)) {
		if (!isRecord(el) || typeof el.type !== 'string' || !has(propsSchemas, el.type)) continue;
		const props = propsSchemas[el.type].safeParse(el.props);
		if (!props.success) {
			for (const i of props.error.issues)
				errors.push(
					`elements/${key}/props${i.path.length ? `/${i.path.join('/')}` : ''}: ${i.message}`
				);
			continue;
		}
		const checks = (source as Source).components[el.type].checks ?? [];
		errors.push(
			...declaredErrors(key, el, props.data as Record<string, unknown>, checks, elements)
		);
	}
	return errors.length
		? { ok: false, errors: [...new Set(errors)] }
		: { ok: true, spec: spec as Spec };
}
