// The presented-view lens's witnesses: the record is read through `present_read` — never
// memory — a failed read renders the refusal and never a partial view, and what is read is
// rendered through TemperView, whose gate runs again on every rebuild. `invoke` is mocked.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from '@tauri-apps/api/core';
import { render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LensProps, TabHandle } from '../lenses';
import type { Subject } from '../subjects';
import PresentedLens from './PresentedLens.svelte';

const RESOURCE = '01a0f000-0000-7000-8000-00000000000a';
const ARTIFACT = '01a0f000-0000-7000-8000-00000000000b';

const subject: Subject = { kind: 'presentation', resource: RESOURCE, artifact: ARTIFACT };

const record = {
	version: 1,
	conversationId: 'c1',
	agent: 'opencode',
	catalogVersion: 'temper@1.0.0',
	presentedAt: '2026-09-30T12:00:00Z',
	spec: {
		root: 'r',
		elements: {
			r: { type: 'RegionState', props: { state: 'failed', label: 'history' }, children: [] }
		}
	},
	outcome: 'rendered'
};

const read = { resource: RESOURCE, artifact: ARTIFACT, record };

const tab = (overrides: Partial<TabHandle> = {}): TabHandle => ({
	setTitle: vi.fn(),
	open: vi.fn(),
	beforeLeave: () => () => {},
	...overrides
});

const props = (over: Partial<LensProps> = {}): LensProps =>
	({ subject, tab: tab(), ...over }) as LensProps;

beforeEach(() => {
	vi.mocked(invoke).mockClear();
});

describe('the presented-view lens', () => {
	it('reads the record from temper through present_read, and renders it through TemperView', async () => {
		vi.mocked(invoke).mockResolvedValue(read as never);
		const { container } = render(PresentedLens, { props: props() });
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith('present_read', {
				resource: RESOURCE,
				artifact: ARTIFACT
			})
		);
		// The spec the record carries renders — through TemperView's own gate.
		await vi.waitFor(() => expect(container.querySelector('.refused')).toBeNull());
		expect(container.querySelector('.who')?.textContent).toContain('opencode');
		expect(container.querySelector('.who')?.textContent).toContain('temper@1.0.0');
		// The lens names the tab after the record's agent, never a guess.
	});

	it("names the tab after the record's presenting agent", async () => {
		const setTitle = vi.fn();
		vi.mocked(invoke).mockResolvedValue(read as never);
		render(PresentedLens, { props: props({ tab: tab({ setTitle }) }) });
		await vi.waitFor(() => expect(setTitle).toHaveBeenCalledWith('presented view — opencode'));
	});

	it('a read the core refuses renders the refusal, never a partial view', async () => {
		vi.mocked(invoke).mockRejectedValue('artifact X is not a presented view');
		const { container } = render(PresentedLens, { props: props() });
		const failed = await vi.waitFor(() => {
			const el = container.querySelector('.region.failed');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		expect(failed.textContent).toContain('artifact X is not a presented view');
		expect(container.textContent).not.toContain('history');
	});

	it('reads exactly once per step — no re-read on focus', async () => {
		vi.mocked(invoke).mockResolvedValue(read as never);
		render(PresentedLens, { props: props() });
		await vi.waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 10));
		expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
	});
});
