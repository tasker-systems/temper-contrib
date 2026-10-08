// The presented-views section's witnesses: the section stands alone — no session store, no
// agent session, no tab strip state — because that condition IS the discarded-tab-state clause:
// the rows come from the records the list read, and each opens the record's own presentation
// subject through the tabs model. `invoke` is mocked.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from '@tauri-apps/api/core';
import { fireEvent, render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LensProps, TabHandle } from '../../lenses';
import { tabs } from '../../tabs.svelte';
import PresentedSection from './PresentedSection.svelte';

const RESOURCE = '01a0f000-0000-7000-8000-00000000000a';
const ARTIFACT = '01a0f000-0000-7000-8000-00000000000b';
const OLDER_RESOURCE = '01a0f000-0000-7000-8000-00000000000c';
const OLDER_ARTIFACT = '01a0f000-0000-7000-8000-00000000000d';

/** How many views the core's answer carries at most — the section names what it omits. */
const CARRY = 20;

const record = (agent: string, presentedAt: string, type = 'RegionState') => ({
	version: 1,
	conversationId: 'c1',
	agent,
	catalogVersion: 'temper@1.0.0',
	presentedAt,
	spec: { root: 'r', elements: { r: { type, props: {}, children: [] } } },
	outcome: 'rendered'
});

/** A small valid answer: the two views are all of them, nothing refused. */
const answer = {
	views: [
		{
			resource: RESOURCE,
			artifact: ARTIFACT,
			record: record('opencode', '2026-09-30T12:00:00Z')
		},
		{
			resource: OLDER_RESOURCE,
			artifact: OLDER_ARTIFACT,
			record: record('witness-agent', '2026-09-30T10:00:00Z', 'Table')
		}
	],
	total: 2,
	refused: 0
};

/** A valid answer with a record the read could not admit: admitted plus refused. */
const withRefused = {
	views: answer.views,
	total: 2,
	refused: 1
};

/** A valid answer at the carry bound: the twenty newest carried, five more on the hubs past it
    — `views.length` is the carry, `total` counts every admitted view. */
const atBound = {
	views: Array.from({ length: CARRY }, (_, i) => {
		const id = `01a0f000-0000-7000-8000-${(i + 1).toString().padStart(12, '0')}`;
		return {
			resource: id,
			artifact: id,
			record: record(`agent ${i + 1}`, `2026-09-${(10 + i).toString().padStart(2, '0')}T12:00:00Z`)
		};
	}),
	total: 25,
	refused: 0
};

const tab = (): TabHandle => ({
	setTitle: vi.fn(),
	open: vi.fn(),
	beforeLeave: () => () => {}
});

const props = (over: Partial<LensProps> = {}): LensProps =>
	({ subject: { kind: 'place', place: 'home' }, tab: tab(), shown: 1, ...over }) as LensProps;

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockResolvedValue(structuredClone(answer) as never);
});

describe('the presented-views section', () => {
	it('arrives, then renders the rows the list answered — from the records alone', async () => {
		const { container } = render(PresentedSection, { props: props() });
		expect(container.querySelector('.region.arriving')).not.toBeNull();
		await vi.waitFor(() => {
			expect(container.querySelectorAll('.entry').length).toBe(2);
			expect(container.querySelector('.region.arriving')).toBeNull();
		});
		const text = container.textContent ?? '';
		expect(text).toContain('opencode');
		expect(text).toContain('witness-agent');
	});

	it('distinguishes rows by the record’s own root component type', async () => {
		const { container } = render(PresentedSection, { props: props() });
		await vi.waitFor(() => expect(container.querySelectorAll('.entry').length).toBe(2));
		const chips = [...container.querySelectorAll('.entry .type')].map((el) => el.textContent);
		expect(chips).toEqual(['RegionState', 'Table']);
	});

	it('never crashes on a degraded record — the chip falls back to the word view', async () => {
		const degraded = {
			views: [
				{
					resource: RESOURCE,
					artifact: ARTIFACT,
					record: {
						...record('opencode', '2026-09-30T12:00:00Z'),
						spec: { root: 'gone', elements: {} }
					}
				}
			],
			total: 1,
			refused: 0
		};
		vi.mocked(invoke).mockResolvedValue(degraded as never);
		const { container } = render(PresentedSection, { props: props() });
		await vi.waitFor(() => expect(container.querySelectorAll('.entry').length).toBe(1));
		expect(container.querySelector('.entry .type')?.textContent).toBe('view');
		expect(container.textContent).toContain('opencode');
	});

	it('opens a row through the tabs model, as the record’s own presentation subject', async () => {
		const spy = vi.spyOn(tabs, 'focusOrOpen').mockReturnValue(true);
		try {
			const { container } = render(PresentedSection, { props: props() });
			await vi.waitFor(() => expect(container.querySelectorAll('.entry').length).toBe(2));
			await fireEvent.click(container.querySelectorAll('.entry')[0]);
			// The newest record's own ids — nothing session-carried.
			expect(spy).toHaveBeenCalledWith(
				{ kind: 'presentation', resource: RESOURCE, artifact: ARTIFACT },
				'core/presentation'
			);
		} finally {
			spy.mockRestore();
		}
	});

	it('names both bounds: the section’s shown-of-total sentence and the remainder past the carry', async () => {
		vi.mocked(invoke).mockResolvedValue(structuredClone(atBound) as never);
		const { container } = render(PresentedSection, { props: props() });
		await vi.waitFor(() => expect(container.querySelectorAll('.entry').length).toBe(5));
		const text = (container.textContent ?? '').replace(/\s+/g, ' ');
		expect(text).toContain('5 of 25 presented views; 20 not shown.');
		expect(text).toContain(
			'The list carries the 20 newest; 5 older ones stay on the hubs’ records.'
		);
	});

	it('counts the records it could not read, and never drops them silently', async () => {
		vi.mocked(invoke).mockResolvedValue(structuredClone(withRefused) as never);
		const { container } = render(PresentedSection, { props: props() });
		await vi.waitFor(() => expect(container.querySelectorAll('.entry').length).toBe(2));
		const text = (container.textContent ?? '').replace(/\s+/g, ' ');
		expect(text).toContain('1 record on the hubs could not be read as a presented view');
		expect(text).toContain('All 2 presented views.');
	});

	it('says when none were presented yet', async () => {
		vi.mocked(invoke).mockResolvedValue({ views: [], total: 0, refused: 0 } as never);
		const { container } = render(PresentedSection, { props: props() });
		await vi.waitFor(() => expect(container.querySelector('.region.empty')).not.toBeNull());
		expect(container.textContent).toContain('No presented views recorded yet');
	});

	it('renders the failure and reads nothing further', async () => {
		vi.mocked(invoke).mockRejectedValue('temper is not connected');
		const { container } = render(PresentedSection, { props: props() });
		const failed = await vi.waitFor(() => {
			const el = container.querySelector('.region.failed');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		expect(failed.textContent).toContain('temper is not connected');
	});

	it('reads once per show — never again while nothing changes', async () => {
		render(PresentedSection, { props: props() });
		await vi.waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1));
		await new Promise((r) => setTimeout(r, 10));
		expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
	});
});
