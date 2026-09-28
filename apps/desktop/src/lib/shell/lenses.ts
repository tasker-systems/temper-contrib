/**
 * The lens registry: data, in-app, one closed contribution shape. A plugin contributes exactly
 * four things — lenses, left-panel entries, vocabularies and property renderers, agent skills and
 * stances — and nothing else can be contributed, so the frame never becomes pluggable by accident.
 *
 * A lens is built, or named and not built. An unbuilt lens is still a lens a tab can open on: it
 * says what it is and what lands it, never an empty placeholder.
 */
import type { Component } from 'svelte';
import type { DocOpened } from '$lib/document';
import type { Place, Subject } from './subjects';

/** What a lens may ask of the tab it is mounted in. */
export interface TabHandle {
	/** Name the step once the lens has read what temper calls its subject. */
	setTitle(title: string): void;
	/** Open a subject: in this tab (a new step on its trail) or in a new tab. */
	open(subject: Subject, where?: 'here' | 'new'): void;
	/**
	 * Be asked before this tab leaves its step or closes. The guard answers `true` to let it go,
	 * or a sentence saying why not. Returns the function that withdraws the guard.
	 */
	beforeLeave(guard: () => true | string): () => void;
}

export interface LensProps {
	subject: Subject;
	/** The host's open answer, for a resource subject: the one read made on opening. */
	opened?: DocOpened;
	tab: TabHandle;
}

export type LensBuild =
	| { state: 'built'; component: () => Promise<{ default: Component<LensProps> }> }
	| { state: 'unbuilt'; landsWith: string };

export interface LensDecl {
	/** `plugin/name` — the address a link or the switcher asks for. */
	id: string;
	/** What the tab header and the switcher say. */
	name: string;
	plugin: string;
	accepts: {
		kinds: Subject['kind'][];
		/** For rule 2; absent means any doc type of an accepted kind. */
		docTypes?: string[];
		/** A place lens names the one place it shows. */
		places?: Place[];
		/** A query lens may accept only queries that name one of these. */
		queryBy?: ('context' | 'docType' | 'text')[];
	};
	build: LensBuild;
}

/** A left-panel entry. Typed here, drawn by the ways-in panel. */
export interface WayInDecl {
	id: string;
	label: string;
}

/** Typed now, empty in this build: property vocabularies and renderers. */
export interface VocabularyDecl {
	id: string;
}

/** Typed now, empty in this build: agent skills and stances. */
export interface SkillDecl {
	id: string;
}

export interface Contribution {
	plugin: string;
	lenses: LensDecl[];
	waysIn: WayInDecl[];
	vocabularies: VocabularyDecl[];
	skills: SkillDecl[];
}

export type Resolution = { lens: LensDecl; reason: 'asked' | 'declared' | 'default' };

const CORE = 'core';

/** Core's default lens for each kind of subject. A place has its own. */
function defaultLensId(subject: Subject): string {
	switch (subject.kind) {
		case 'resource':
			return 'core/document';
		case 'query':
			return 'core/table';
		case 'neighbourhood':
			return 'core/graph';
		case 'place':
			return `core/${subject.place}`;
	}
}

/** Whether a lens can show a subject of this doc type (the doc type only a read can tell). */
export function accepts(lens: LensDecl, subject: Subject, docType?: string | null): boolean {
	const a = lens.accepts;
	if (!a.kinds.includes(subject.kind)) return false;
	if (subject.kind === 'place') return a.places?.includes(subject.place) ?? false;
	if (a.places) return false;
	if (subject.kind === 'query' && a.queryBy) {
		if (!a.queryBy.some((by) => Boolean(subject[by]))) return false;
	}
	if (a.docTypes && docType && !a.docTypes.includes(docType)) return false;
	return true;
}

function allLenses(contributions: readonly Contribution[]): LensDecl[] {
	return contributions.flatMap((c) => c.lenses);
}

const built = (lens: LensDecl) => lens.build.state === 'built';

/**
 * Which lens a subject is seen through, and why:
 * 1. the lens the link asked for, if it is enabled and accepts the subject;
 * 2. else the first enabled non-core lens that declares the subject's doc type;
 * 3. else core's default for the subject's kind.
 * An unbuilt lens is never chosen by rules 2 or 3 when a built one also accepts the subject.
 * `null` only when nothing enabled accepts the subject at all.
 */
export function resolveLens(
	subject: Subject,
	docType: string | null | undefined,
	asked: string | null | undefined,
	contributions: readonly Contribution[]
): Resolution | null {
	const lenses = allLenses(contributions);
	const candidates = lenses.filter((lens) => accepts(lens, subject, docType));

	if (asked) {
		const lens = candidates.find((l) => l.id === asked);
		if (lens) return { lens, reason: 'asked' };
	}

	if (docType) {
		const declared = candidates.filter(
			(l) => l.plugin !== CORE && l.accepts.docTypes?.includes(docType)
		);
		const lens = declared.find(built) ?? (candidates.some(built) ? undefined : declared[0]);
		if (lens) return { lens, reason: 'declared' };
	}

	const fallback = candidates.find((l) => l.id === defaultLensId(subject));
	if (fallback && built(fallback)) return { lens: fallback, reason: 'default' };
	const anyBuilt = candidates.find(built);
	if (anyBuilt) return { lens: anyBuilt, reason: 'default' };
	return fallback ? { lens: fallback, reason: 'default' } : null;
}

/**
 * What the switcher offers for a subject: every enabled lens that accepts it, built or not. A
 * place has one way of being seen, so its lens is never offered.
 */
export function lensesFor(
	subject: Subject,
	docType: string | null | undefined,
	contributions: readonly Contribution[]
): LensDecl[] {
	if (subject.kind === 'place') return [];
	return allLenses(contributions).filter((lens) => accepts(lens, subject, docType));
}

/** One lens by id, among the enabled contributions. */
export function lensById(id: string, contributions: readonly Contribution[]): LensDecl | null {
	return allLenses(contributions).find((l) => l.id === id) ?? null;
}
