/**
 * Theme selection. Every theme under the repository's `themes/` is discovered at build time, so a
 * new theme needs no code here. The choice is a per-device convenience for now (localStorage);
 * as a per-person fact it belongs in temper, which is later work.
 */

export type Appearance = 'dark' | 'light';

export interface ThemeMeta {
	name: string;
	title: string;
	appearance: Appearance;
	counterpart?: string;
}

/** Follow the system's appearance within a family (a theme and its counterpart), or fix one theme. */
export type ThemePreference =
	| { follow: 'system'; family: string }
	| { follow: 'fixed'; name: string };

const discovered = import.meta.glob<ThemeMeta>('../../../../themes/*/theme.json', {
	eager: true,
	import: 'default'
});

export const THEMES: ThemeMeta[] = Object.values(discovered)
	.map(({ name, title, appearance, counterpart }) => ({ name, title, appearance, counterpart }))
	.sort((a, b) => a.name.localeCompare(b.name));

export const DEFAULT_PREFERENCE: ThemePreference = { follow: 'system', family: 'quiet-instrument' };

const STORAGE_KEY = 'temper-desktop.theme';

/** The theme name a preference selects, given the system's appearance. Never returns an unknown name. */
export function resolveTheme(
	pref: ThemePreference,
	systemDark: boolean,
	themes: ThemeMeta[] = THEMES
): string {
	const find = (name: string) => themes.find((t) => t.name === name);
	const fallback = find('quiet-instrument') ?? themes[0];
	if (pref.follow === 'fixed') return (find(pref.name) ?? fallback).name;
	const base = find(pref.family) ?? fallback;
	const want: Appearance = systemDark ? 'dark' : 'light';
	if (base.appearance === want) return base.name;
	const other = base.counterpart ? find(base.counterpart) : undefined;
	return other && other.appearance === want ? other.name : base.name;
}

function isPreference(value: unknown): value is ThemePreference {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		(v.follow === 'system' && typeof v.family === 'string') ||
		(v.follow === 'fixed' && typeof v.name === 'string')
	);
}

/** Storage can be absent or throw (private windows, cleared site data); the default always stands in. */
export function loadPreference(storage: Pick<Storage, 'getItem'> | undefined): ThemePreference {
	try {
		const raw = storage?.getItem(STORAGE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		return isPreference(parsed) ? parsed : DEFAULT_PREFERENCE;
	} catch {
		return DEFAULT_PREFERENCE;
	}
}

export function savePreference(storage: Pick<Storage, 'setItem'> | undefined, pref: ThemePreference): void {
	try {
		storage?.setItem(STORAGE_KEY, JSON.stringify(pref));
	} catch {
		// A preference that cannot be stored still applies for this session.
	}
}
