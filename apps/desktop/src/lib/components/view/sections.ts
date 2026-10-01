/**
 * How a Section learns what holds it. json-render hands a component its children as one
 * snippet, so Tabs and Accordion cannot place each child themselves: each Section asks its
 * holder instead, by context, and takes its place — a tab panel, a collapsible item, or (held
 * by neither) a titled block.
 */
import { getContext, setContext } from 'svelte';

export type Holder = {
	kind: 'tabs' | 'accordion';
	/** Called once as a Section initialises; returns the value that identifies it. */
	join(title: string, open: boolean): string;
};

const KEY = Symbol('section-holder');

export const holdSections = (holder: Holder): Holder => setContext(KEY, holder);

/** The holder, or null for a Section on its own. A Section clears it for what it holds. */
export const sectionHolder = (): Holder | null => getContext<Holder | null>(KEY) ?? null;

export const releaseSections = (): void => {
	setContext(KEY, null);
};
