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

const record = (agent: string, presentedAt: string) => ({
	version: 1,
	conversationId: 'c1',
	agent,
	catalogVersion: 'temper@1.0.0',
	presentedAt,
	spec: {
		root: 'r',
		elements: {
			r: { type: 'RegionState', props: { state: 'failed', label: 'history' }, children: [] }
		}
	},
	outcome: 'rendered'
});

const answer = {
	views: [
		{ resource: RESOURCE, artifact: ARTIFACT, record: record('opencode', '2026-09-30T12:00:00Z') },
		{
			resource: OLDER_RESOURCE,
			artifact: OLDER_ARTIFACT,
			record: record('witness-agent', '2026-09-30T10:00:00Z')
		}
	],
	total: 5,
	refused: 1
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

	it('names its bounds: the shown-of-total sentence, the unreadable, the remainder past the list', async () => {
		const { container } = render(PresentedSection, { props: props() });
		await vi.waitFor(() => expect(container.querySelectorAll('.entry').length).toBe(2));
		const text = (container.textContent ?? '').replace(/\s+/g, ' ');
		expect(text).toContain('2 of 5 presented views; 3 not shown.');
		expect(text).toContain('could not be read as a presented view');
		expect(text).toContain(
			'The list carries the 2 newest; 3 older ones stay on the hubs’ records.'
		);
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
