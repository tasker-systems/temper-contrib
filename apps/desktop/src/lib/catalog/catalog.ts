/**
 * The `temper` catalog: `temper.catalog.json` is the single source. Its props are JSON Schema so
 * the same file serves the renderer here and any headless surface; they become zod here through
 * `z.fromJSONSchema`, which keeps `required` and `additionalProperties: false`.
 */
import { defineCatalog, type Spec } from '@json-render/core';
import { schema } from '@json-render/svelte';
import { z } from 'zod';
import source from './temper.catalog.json';

type Source = {
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
 * Then what JSON Schema cannot say: every child an element names exists (a missing child hides
 * its branch silently), and a BoundedList never shows more rows than it stands for, nor a
 * different number of rows than it has.
 */
export function checkSpec(spec: unknown): SpecCheck {
	const errors: string[] = [];
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
	const shaped = spec as Partial<Spec> | null;
	const elements = shaped && typeof shaped.elements === 'object' && shaped.elements ? shaped.elements : null;
	if (!elements) return { ok: false, errors: errors.length ? errors : ['spec has no elements'] };

	for (const [key, el] of Object.entries(elements)) {
		const component = propsSchemas[el?.type];
		if (!component) continue; // an unknown type is already refused above
		const props = component.safeParse(el.props);
		if (!props.success) {
			for (const i of props.error.issues)
				errors.push(`elements/${key}/props${i.path.length ? '/' + i.path.join('/') : ''}: ${i.message}`);
			continue;
		}
		for (const child of el.children ?? [])
			if (!(child in elements)) errors.push(`elements/${key}: names a child "${child}" that does not exist`);
		if (el.type === 'BoundedList') {
			const p = el.props as { total: number; shown: number; state: string };
			if (p.shown > p.total) errors.push(`elements/${key}: shows ${p.shown} of ${p.total}`);
			if (p.state === 'present' && (el.children ?? []).length !== p.shown)
				errors.push(`elements/${key}: says it shows ${p.shown} but has ${(el.children ?? []).length} rows`);
		}
	}
	if (typeof shaped?.root === 'string' && !(shaped.root in elements))
		errors.push(`root: "${shaped.root}" is not an element`);
	return errors.length ? { ok: false, errors } : { ok: true, spec: spec as Spec };
}
