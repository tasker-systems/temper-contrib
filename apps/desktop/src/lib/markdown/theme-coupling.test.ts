import { describe, expect, it } from 'vitest';
import renderer from '../components/MarkdownRenderer.svelte?raw';
import palette from '../shell/CommandPalette.svelte?raw';
import masthead from '../shell/Masthead.svelte?raw';
import roomStrip from '../shell/RoomStrip.svelte?raw';
import shell from '../shell/Shell.svelte?raw';
import tabStrip from '../shell/TabStrip.svelte?raw';
import unbuiltLens from '../shell/UnbuiltLens.svelte?raw';
import waysIn from '../shell/WaysIn.svelte?raw';

/**
 * The theme-coupling witness (rendering-baseline design): the rendered-document stylesheet
 * resolves only through `--tp-*` roles that every theme defines. `guard:colours` already
 * refuses literal colours; this goes further, because the baseline's own stylesheet shows the
 * gap — it styled through `--color-quiet-*` custom properties, which carry no literal and would
 * pass the guard while resolving to nothing on the desktop. The shell's stylesheets ride the
 * same witness — chrome styles through the contract like everything else.
 */
// Each theme's `theme.json` is its source of truth; its `theme.css` is generated from it. A
// colour token `x` is the role `--tp-x`; every other group `g` token `x` is `--tp-g-x`.
type ThemeTokens = { tokens: Record<string, Record<string, unknown>> };
const themeFiles = import.meta.glob<ThemeTokens>('../../../../../themes/*/theme.json', {
	import: 'default',
	eager: true
});
const themes: [string, Set<string>][] = Object.entries(themeFiles).map(([path, theme]) => [
	path.split('/').at(-2) ?? path,
	new Set(
		Object.entries(theme.tokens).flatMap(([group, tokens]) =>
			Object.keys(tokens).map((name) =>
				group === 'color' ? `--tp-${name}` : `--tp-${group}-${name}`
			)
		)
	)
]);

const components: [string, string, RegExp][] = [
	[
		'the rendered-document stylesheet',
		renderer.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '',
		/\.md-body/
	],
	...(
		[
			['masthead', masthead, /\.masthead/],
			['tab strip', tabStrip, /\.tab/],
			['room strip', roomStrip, /\.room-strip/],
			['shell', shell, /\.agent-pending/],
			['unbuilt lens', unbuiltLens, /\.words/],
			['ways-in panel', waysIn, /\.ways-in/],
			['command palette', palette, /\.palette/]
		] as const
	).map(([name, source, marker]): [string, string, RegExp] => [
		`the ${name} stylesheet`,
		source.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '',
		marker
	])
];

describe.each(components)('%s', (_name, style, marker) => {
	it('finds the themes and the stylesheet it witnesses', () => {
		expect(themes.length).toBeGreaterThanOrEqual(2);
		expect(style).toMatch(marker);
	});

	it('references only --tp-* roles', () => {
		const refs = [...style.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]);
		expect(refs.length).toBeGreaterThan(0);
		expect(refs.filter((r) => !r.startsWith('--tp-'))).toEqual([]);
	});

	it.each(themes)('resolves every role it reads in %s', (_theme, roles) => {
		const refs = new Set([...style.matchAll(/var\(\s*(--tp-[a-z0-9-]+)/g)].map((m) => m[1]));
		expect([...refs].filter((r) => !roles.has(r))).toEqual([]);
	});

	it('paints colour only through roles', () => {
		const painted = [
			...style.matchAll(
				/(?:^|[;{\s])((?:background|border[a-z-]*|color|outline[a-z-]*|fill|stroke)\s*:\s*[^;}]+)/g
			)
		].map((m) => m[1]);
		const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color-mix)\(/;
		expect(painted.filter((decl) => literal.test(decl))).toEqual([]);
	});
});
