/**
 * The binding merge's witnesses: what each doc type's marks paint with. Core's default
 * binding is the base of the merge, a plugin's entry for a doc type wins it in
 * registration order, and a doc type bound nowhere answers the neutral role — the one
 * mark the contract gives anything no vocabulary claimed.
 */
import { describe, expect, it } from 'vitest';
import type { Contribution } from '../lenses';
import { boundVocabularies, docTypeTint } from './bindings';

const pluginWithTints = (tints: Record<string, string>): Contribution => ({
	plugin: 'storyteller',
	lenses: [],
	waysIn: [],
	vocabularies: [
		{
			id: 'create',
			doctypes: Object.entries(tints).map(([doctype, tint]) => ({
				doctype,
				tint: tint as never
			}))
		}
	],
	skills: []
});

const core = pluginWithTints({});

describe('the binding merge', () => {
	it('starts from the core default binding, before any plugin', () => {
		const bindings = boundVocabularies([core]);
		expect(bindings[0].id).toBe('core');
		expect(bindings[0].doctypes['task']).toBe('cat-6');
		expect(bindings).toHaveLength(1);
	});

	it('a plugin entry for a doc type wins the base one', () => {
		const storyteller = pluginWithTints({ task: 'cat-3', character: 'cat-3' });
		expect(boundVocabularies([core, storyteller]).map((b) => b.id)).toEqual([
			'core',
			'storyteller'
		]);
		// Core bound `task` to cat-6; the plugin's entry for it wins. Its own kind
		// rides the same slot — one vocabulary may share a slot.
		expect(docTypeTint([core, storyteller], 'task')).toBe('cat-3');
		expect(docTypeTint([core, storyteller], 'character')).toBe('cat-3');
		// And a kind the plugin did not bind still answers the core default.
		expect(docTypeTint([core, storyteller], 'goal')).toBe('cat-8');
	});

	it('a doc type bound nowhere answers the neutral role', () => {
		expect(docTypeTint([core], 'character')).toBe('cat-neutral');
		expect(docTypeTint([core], '')).toBe('cat-neutral');
	});
});
