/**
 * The plugin loader: how the desktop turns package files into contributions. A package arrives as
 * a name and the texts of its files; the zod schemas below are the manifest format's one source of
 * truth, and every object is strict, so an unknown component name, an unknown default kind, an
 * extra key, a lens id its own package name does not namespace, or an unparseable manifest is a
 * refusal — named with the package, the fault and the field path in one sentence — never a
 * half-loaded package. The loader is pure: sources in, contributions and refusals out, no disk,
 * no Tauri, so a test can feed it anything from anywhere.
 */
import type { Component } from 'svelte';
import { z } from 'zod';
import type { Contribution, LensDecl, LensProps, WayInDecl } from '../lenses';

/** What a package hands the loader: its name, and the raw text of each file it carries. */
export interface PackageSource {
	name: string;
	files: readonly { path: string; text: string }[];
}

/** What the loader answers: the contributions that parsed whole, and one sentence per refusal. */
export interface LoadedContributions {
	contributions: Contribution[];
	refusals: string[];
}

/** The components a built lens may mount, by the name its manifest declares. */
type LensModule = Promise<{ default: Component<LensProps> }>;

const COMPONENTS: Record<string, () => LensModule> = {
	'home-handoff': () => import('../lenses/home/HandoffSection.svelte'),
	'home-recent': () => import('../lenses/home/RecentlyUpdatedSection.svelte')
};

/** The open-tier default kinds a manifest may set, and what each resolves to at the create moment. */
const DEFAULT_KINDS = { date: 'today' } as const;

const KINDS = ['resource', 'query', 'neighbourhood', 'presentation', 'place'] as const;

const PLACES = ['home', 'settings', 'setup', 'catalog', 'new-resource'] as const;

const QUERY_BY = ['context', 'docType', 'text'] as const;

const defaultsShape = z.strictObject({ date: z.literal(DEFAULT_KINDS.date) });

const filterShape = z.strictObject({
	docType: z.string().optional(),
	stage: z.string().optional(),
	status: z.string().optional(),
	contextRef: z.string().optional(),
	owner: z.string().optional()
});

const buildShape = z.discriminatedUnion('state', [
	z.strictObject({ state: z.literal('built'), component: z.string() }),
	z.strictObject({ state: z.literal('unbuilt'), landsWith: z.string() })
]);

const lensShape = z.strictObject({
	id: z.string(),
	name: z.string(),
	accepts: z.strictObject({
		kinds: z.array(z.enum(KINDS)),
		docTypes: z.array(z.string()).optional(),
		places: z.array(z.enum(PLACES)).optional(),
		queryBy: z.array(z.enum(QUERY_BY)).optional()
	}),
	build: buildShape,
	pinned: z.strictObject({ home: z.number().int() }).optional(),
	group: z.string().optional()
});

const wayInShape = z.strictObject({
	id: z.string(),
	label: z.string(),
	scope: z.string(),
	source: z.union([
		z.strictObject({ source: z.literal('contexts') }),
		z.strictObject({ source: z.literal('recent') }),
		z.strictObject({ source: z.literal('list'), filter: filterShape })
	])
});

const doctypeShape = z.strictObject({
	doctype: z.string(),
	defaults: defaultsShape.optional()
});

const vocabularyShape = z.strictObject({
	id: z.string(),
	doctypes: z.array(doctypeShape)
});

const skillShape = z.strictObject({ id: z.string() });

const contributionsShape = z.strictObject({
	lenses: z.array(lensShape),
	waysIn: z.array(wayInShape),
	vocabularies: z.array(vocabularyShape),
	skills: z.array(skillShape)
});

const manifestShape = z.strictObject({
	name: z.string(),
	contributions: contributionsShape
});

/** One refusal sentence: the package, the fault, and the field path, in that order. */
function refusal(packageName: string, fault: string, path: string): string {
	return `refused the ${packageName} package: ${fault} at ${path}`;
}

/** A zod issue's path as the manifest names it: `contributions.lenses[0].build.component`. */
function fieldPath(path: readonly (string | number)[]): string {
	return path.reduce<string>(
		(whole, step) =>
			typeof step === 'number' ? `${whole}[${step}]` : whole ? `${whole}.${step}` : step,
		''
	);
}

/** The one default kind the format admits, resolved against the create moment. */
function resolvedDefaults(): (today: string) => Record<string, unknown> {
	return (today) => ({ date: today });
}

export function loadContributions(sources: readonly PackageSource[]): LoadedContributions {
	const contributions: Contribution[] = [];
	const refusals: string[] = [];
	for (const source of sources) {
		loadPackage(source, contributions, refusals);
	}
	return { contributions, refusals };
}

function loadPackage(
	source: PackageSource,
	contributions: Contribution[],
	refusals: string[]
): void {
	const file = source.files.find((candidate) => candidate.path === 'plugin.json');
	if (!file) {
		refusals.push(refusal(source.name, 'its files carry no plugin.json', 'plugin.json'));
		return;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(file.text);
	} catch {
		refusals.push(refusal(source.name, 'its plugin.json is not parseable JSON', 'plugin.json'));
		return;
	}
	const manifest = manifestShape.safeParse(raw);
	if (!manifest.success) {
		const issue = manifest.error.issues[0];
		refusals.push(
			refusal(source.name, issue.message, fieldPath(issue.path as (string | number)[]))
		);
		return;
	}
	const plugin = manifest.data.name;
	const lenses: LensDecl[] = [];
	for (const [index, lens] of manifest.data.contributions.lenses.entries()) {
		if (!lens.id.startsWith(`${plugin}/`)) {
			refusals.push(
				refusal(
					plugin,
					'its lens id is not namespaced by the package name',
					`contributions.lenses[${index}].id`
				)
			);
			return;
		}
		const base = {
			id: lens.id,
			name: lens.name,
			plugin,
			accepts: lens.accepts,
			pinned: lens.pinned,
			group: lens.group
		};
		if (lens.build.state === 'unbuilt') {
			lenses.push({ ...base, build: { state: 'unbuilt', landsWith: lens.build.landsWith } });
			continue;
		}
		const component = COMPONENTS[lens.build.component];
		if (!component) {
			refusals.push(
				refusal(
					plugin,
					`no such component '${lens.build.component}'`,
					`contributions.lenses[${index}].build.component`
				)
			);
			return;
		}
		lenses.push({ ...base, build: { state: 'built', component } });
	}
	const waysIn: WayInDecl[] = manifest.data.contributions.waysIn.map((way) => {
		if (way.source.source !== 'list') {
			return { id: way.id, label: way.label, scope: way.scope, source: way.source.source };
		}
		return {
			id: way.id,
			label: way.label,
			scope: way.scope,
			source: 'list' as const,
			filter: way.source.filter
		};
	});
	contributions.push({
		plugin,
		lenses,
		waysIn,
		vocabularies: manifest.data.contributions.vocabularies.map((vocabulary) => ({
			id: vocabulary.id,
			doctypes: vocabulary.doctypes.map((doctype) => ({
				doctype: doctype.doctype,
				defaults: doctype.defaults && resolvedDefaults()
			}))
		})),
		skills: manifest.data.contributions.skills
	});
}
