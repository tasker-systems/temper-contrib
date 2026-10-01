import { describe, expect, it } from 'vitest';
import { omissionSentence } from './omission';

describe('the omission sentence', () => {
	it('says what an unpaged view leaves out', () => {
		expect(omissionSentence(12, 12, 'in this context')).toBe('All 12 in this context.');
		expect(omissionSentence(12, 3, 'in this context')).toBe(
			'3 of 12 in this context; 9 not shown.'
		);
	});

	it('says a first page of 50 out of 51 is not all of them', () => {
		const page = { offset: 0, size: 50, more: true };
		expect(omissionSentence(51, 50, 'tasks', page)).toBe('1–50 of 51 tasks; 1 after it.');
	});

	it('says what lies either side of a middle page, and only before the last', () => {
		expect(omissionSentence(230, 50, 'tasks', { offset: 50, size: 50, more: true })).toBe(
			'51–100 of 230 tasks; 50 before this page, 130 after it.'
		);
		expect(omissionSentence(230, 30, 'tasks', { offset: 200, size: 50, more: false })).toBe(
			'201–230 of 230 tasks; 200 before this page.'
		);
	});

	it('calls a single whole page all of them', () => {
		expect(omissionSentence(7, 7, 'tasks', { offset: 0, size: 50, more: false })).toBe(
			'All 7 tasks.'
		);
	});
});
