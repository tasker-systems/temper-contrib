import { describe, expect, it } from 'vitest';
import { THEMES, DEFAULT_PREFERENCE, loadPreference, resolveTheme } from './theme';

describe('theme discovery', () => {
	it('finds every theme in themes/, paired as counterparts', () => {
		const names = THEMES.map((t) => t.name);
		expect(names).toContain('quiet-instrument');
		expect(names).toContain('quiet-instrument-paper');
		for (const t of THEMES) {
			if (!t.counterpart) continue;
			const other = THEMES.find((o) => o.name === t.counterpart);
			expect(other?.counterpart).toBe(t.name);
		}
	});
});

describe('resolveTheme', () => {
	it('follows the system within a family', () => {
		const pref = { follow: 'system', family: 'quiet-instrument' } as const;
		expect(resolveTheme(pref, true)).toBe('quiet-instrument');
		expect(resolveTheme(pref, false)).toBe('quiet-instrument-paper');
		const paper = { follow: 'system', family: 'quiet-instrument-paper' } as const;
		expect(resolveTheme(paper, true)).toBe('quiet-instrument');
	});
	it('holds a fixed theme regardless of the system', () => {
		expect(resolveTheme({ follow: 'fixed', name: 'quiet-instrument-paper' }, true)).toBe('quiet-instrument-paper');
	});
	it('never returns a theme that does not exist', () => {
		expect(resolveTheme({ follow: 'fixed', name: 'neon' }, true)).toBe('quiet-instrument');
		expect(resolveTheme({ follow: 'system', family: 'neon' }, false)).toBe('quiet-instrument-paper');
	});
});

describe('loadPreference', () => {
	it('falls back to the default on absent, malformed or throwing storage', () => {
		expect(loadPreference(undefined)).toEqual(DEFAULT_PREFERENCE);
		expect(loadPreference({ getItem: () => '{not json' })).toEqual(DEFAULT_PREFERENCE);
		expect(loadPreference({ getItem: () => '{"follow":"sideways"}' })).toEqual(DEFAULT_PREFERENCE);
		expect(loadPreference({ getItem: () => { throw new Error('blocked'); } })).toEqual(DEFAULT_PREFERENCE);
	});
	it('reads a stored preference', () => {
		const stored = { follow: 'fixed', name: 'quiet-instrument-paper' };
		expect(loadPreference({ getItem: () => JSON.stringify(stored) })).toEqual(stored);
	});
});
