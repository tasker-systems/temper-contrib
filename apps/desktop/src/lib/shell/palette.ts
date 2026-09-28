/**
 * The command palette's model: what it offers, filtered locally over what the desktop already
 * holds. Four kinds of command — open (open and set-aside tabs, recent work, contexts, the
 * workflow entries), switch lens, start a session, and open settings or setup. Every section is
 * bounded and says what it omits. The palette does not search temper: search is a lens that is
 * not built yet, and the palette says so rather than pretending.
 */
import type { LensDecl } from './lenses';

export type Command = {
	/** Unique within the palette. */
	id: string;
	label: string;
	/** Where it comes from, in words: "open tab", "recent work", "core", … */
	from: string;
	run: () => void;
};

export type Section = { title: string; commands: Command[] };

/** How many commands a section shows before it says how many more there are. */
export const SECTION_BOUND = 6;

export type ShownSection = Section & { shown: Command[]; omitted: number };

/** Keep the commands whose label or origin holds every word of the filter, in order. */
export function filterSections(sections: Section[], filter: string): ShownSection[] {
	const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
	return sections
		.map((section) => {
			const kept = section.commands.filter((c) => {
				const hay = `${c.label} ${c.from}`.toLowerCase();
				return words.every((w) => hay.includes(w));
			});
			return {
				...section,
				commands: kept,
				shown: kept.slice(0, SECTION_BOUND),
				omitted: Math.max(0, kept.length - SECTION_BOUND)
			};
		})
		.filter((s) => s.commands.length > 0);
}

/** The words a lens is offered under in the palette. */
export function lensWords(lens: LensDecl): string {
	return `${lens.name} · ${lens.plugin}${lens.build.state === 'unbuilt' ? ' — not built yet' : ''}`;
}
