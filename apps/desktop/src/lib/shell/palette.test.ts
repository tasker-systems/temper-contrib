import { describe, expect, it } from 'vitest';
import { type Command, filterSections, SECTION_BOUND } from './palette';

const command = (label: string, from = 'core'): Command => ({
	id: label,
	label,
	from,
	run: () => {}
});

describe('filtering the palette', () => {
	it('keeps a command when its label or origin holds every word, in any case', () => {
		const shown = filterSections(
			[{ title: 'Do', commands: [command('Open settings'), command('Open app setup')] }],
			'OPEN set'
		);
		expect(shown[0].commands.map((c) => c.label)).toEqual(['Open settings', 'Open app setup']);
		expect(filterSections(shown, 'settings core')[0].commands.map((c) => c.label)).toEqual([
			'Open settings'
		]);
	});

	it('bounds each section and counts what it leaves out', () => {
		const many = Array.from({ length: SECTION_BOUND + 3 }, (_, i) => command(`Doc ${i}`));
		const [section] = filterSections([{ title: 'Open', commands: many }], '');
		expect(section.shown).toHaveLength(SECTION_BOUND);
		expect(section.omitted).toBe(3);
	});

	it('drops a section with nothing left in it', () => {
		expect(
			filterSections([{ title: 'Do', commands: [command('Open settings')] }], 'graph')
		).toEqual([]);
	});
});
