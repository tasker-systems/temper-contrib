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
		{ description: string; slots: string[]; example?: unknown; props: Record<string, unknown> }
	>;
};

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

export const temperCatalog = defineCatalog(schema, { components, actions: {} });

export const CATALOG_VERSION = `temper@${(source as { version: string }).version}`;

export type SpecCheck = { ok: true; spec: Spec } | { ok: false; errors: string[] };

/** The most elements, the deepest nesting, and the longest element name a temper@1 view may
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
 * say: a BoundedList never shows more rows than it stands for, nor a different number of rows
 * than it has.
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
		if (el.type === 'BoundedList') {
			const p = props.data as { total: number; shown: number; state: string };
			const rows = Array.isArray(el.children) ? el.children.length : 0;
			if (p.shown > p.total) errors.push(`elements/${key}: shows ${p.shown} of ${p.total}`);
			if (p.state === 'present' && rows !== p.shown)
				errors.push(`elements/${key}: says it shows ${p.shown} but has ${rows} rows`);
		}
	}
	return errors.length
		? { ok: false, errors: [...new Set(errors)] }
		: { ok: true, spec: spec as Spec };
}
