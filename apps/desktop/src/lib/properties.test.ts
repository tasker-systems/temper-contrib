// Carried from temper-ui's properties.test.ts and propertyValue.test.ts (tasker-systems/temper,
// at ee12cd5), the read half only — the offered-controls cases belong to metadata editing.
import { describe, expect, it } from 'vitest';
import { classifyValue, mergeProperties } from './properties';

describe('mergeProperties', () => {
	it('puts doc_type first, always', () => {
		const rows = mergeProperties({ 'temper-stage': 'done' }, { zebra: 1 }, 'concept');
		expect(rows[0]).toEqual({ key: 'doc_type', value: 'concept', managed: true });
	});

	it('orders managed keys by MANAGED_KEY_ORDER, not alphabetically', () => {
		const rows = mergeProperties(
			{ 'temper-provenance': 'user-created', 'temper-stage': 'done' },
			null,
			'task'
		);
		expect(rows.map((r) => r.key)).toEqual(['doc_type', 'temper-stage', 'temper-provenance']);
	});

	it('orders open keys alphabetically, after all managed keys', () => {
		const rows = mergeProperties({ 'temper-stage': 'done' }, { zebra: 1, alpha: 2 }, 'task');
		expect(rows.map((r) => r.key)).toEqual(['doc_type', 'temper-stage', 'alpha', 'zebra']);
	});

	it('decides the tier by which argument a key arrives in, never by its name', () => {
		const rows = mergeProperties(
			{ 'temper-newly-minted': 'v' },
			{ 'temper-invented': 'x' },
			'task'
		);
		expect(rows.map((r) => [r.key, r.managed])).toEqual([
			['doc_type', true],
			['temper-newly-minted', true],
			['temper-invented', false]
		]);
	});

	it('ranks editorial keys ahead of managed keys it has no opinion about', () => {
		const rows = mergeProperties(
			{ 'temper-zeta': 1, 'temper-provenance': 'user-created', 'temper-alpha': 2 },
			null,
			'task'
		);
		expect(rows.map((r) => r.key)).toEqual([
			'doc_type',
			'temper-provenance',
			'temper-alpha',
			'temper-zeta'
		]);
		expect(rows.every((r) => r.managed)).toBe(true);
	});

	it('drops null-valued keys and keeps falsy-but-present ones', () => {
		const rows = mergeProperties(
			{ 'temper-stage': null },
			{ alpha: null, zero: 0, empty: '', no: false },
			'task'
		);
		expect(rows.map((r) => r.key)).toEqual(['doc_type', 'empty', 'no', 'zero']);
	});

	it('handles both tiers absent', () => {
		expect(mergeProperties(null, null, 'kernel_landmark')).toEqual([
			{ key: 'doc_type', value: 'kernel_landmark', managed: true }
		]);
	});
});

describe('classifyValue', () => {
	it('renders scalars inline and absence as a dash', () => {
		expect(classifyValue('done')).toEqual({ kind: 'scalar', text: 'done' });
		expect(classifyValue(3)).toEqual({ kind: 'scalar', text: '3' });
		expect(classifyValue(false)).toEqual({ kind: 'scalar', text: 'false' });
		expect(classifyValue(null)).toEqual({ kind: 'scalar', text: '—' });
	});

	it('collapses lists and objects to a summary, and empty ones to a literal', () => {
		expect(classifyValue(['a', 'b'])).toMatchObject({ kind: 'array', summary: '[2]' });
		expect(classifyValue({ a: 1 })).toMatchObject({ kind: 'object', summary: '{1 key}' });
		expect(classifyValue({ a: 1, b: 2 })).toMatchObject({ kind: 'object', summary: '{2 keys}' });
		expect(classifyValue([])).toEqual({ kind: 'scalar', text: '[]' });
		expect(classifyValue({})).toEqual({ kind: 'scalar', text: '{}' });
	});
});
