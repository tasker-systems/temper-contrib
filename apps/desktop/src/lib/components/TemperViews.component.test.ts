// The store singleton is driven directly; `invoke` is mocked so nothing here needs Tauri.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from '@tauri-apps/api/core';
import { render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type TemperRecentRow, type TemperTeam, temperViews } from '../temper-views.svelte';
import Views from './TemperViews.svelte';

const STALE = () => Date.now() - 10 * 60 * 1000;

const TEAMS: TemperTeam[] = [
	{ id: 't1', slug: 'temper-dev', name: 'temper-dev', description: 'the temper developers' },
	{ id: 't2', slug: 'tasker', name: 'tasker', description: null }
];

const ROW = (n: number): TemperRecentRow => ({
	id: `r${n}`,
	decoratedRef: `work-item-${n}`,
	title: `Work item ${n}`,
	docType: 'task',
	contextRef: '@me/contrib',
	updated: '2026-09-27T00:00:00Z'
});

describe('TemperViews', () => {
	beforeEach(() => {
		vi.mocked(invoke).mockClear();
		temperViews.reset();
	});

	it('renders teams and contexts with their bounds said', () => {
		temperViews.teams = TEAMS;
		temperViews.teamsFresh = true;
		temperViews.contexts = [
			{
				id: 'c1',
				name: 'contrib',
				slug: 'contrib',
				ownerRef: '@me',
				resourceCount: 7,
				updated: '2026-09-27T00:00:00Z'
			}
		];
		temperViews.contextsFresh = true;
		const { container } = render(Views);
		const text = container.textContent ?? '';
		expect(text).toContain('temper-dev');
		expect(text).toContain('@me/contrib');
		expect(text).toContain('All 2 of your teams.');
		expect(text).toContain('7 resources');
	});

	it('renders the recent-work page and says what it omits', () => {
		temperViews.recent = { total: 214, rows: Array.from({ length: 10 }, (_, i) => ROW(i)) };
		temperViews.recentFresh = true;
		const { container } = render(Views);
		const text = container.textContent ?? '';
		expect(text).toContain('Work item 0');
		expect(text).toContain(
			'10 of 214 recently updated resources your temper credentials can see; 204 not shown.'
		);
		expect(text).toContain('Show 10 more');
	});

	it('offers no Show more when the page holds everything', () => {
		temperViews.recent = { total: 3, rows: [ROW(1), ROW(2), ROW(3)] };
		temperViews.recentFresh = true;
		const { container } = render(Views);
		expect(container.textContent).toContain('All 3 recently updated resources');
		expect(container.querySelector('button')).toBeNull();
	});

	it('renders the arriving states while nothing has been read', () => {
		const { container } = render(Views);
		const text = container.textContent ?? '';
		expect(text).toContain('Loading teams…');
		expect(text).toContain('Loading contexts…');
		expect(text).toContain('Loading recent work…');
	});

	it('names the failure and that nothing was read, per list', () => {
		temperViews.teamsError = 'temper is not connected';
		temperViews.contextsError = 'temper is not connected';
		temperViews.recentError = 'temper is not connected';
		const { container } = render(Views);
		const text = container.textContent ?? '';
		expect(text).toContain('Teams unavailable — nothing was read.');
		expect(text).toContain('Contexts unavailable — nothing was read.');
		expect(text).toContain('Recent work unavailable — nothing was read.');
	});

	it('degrades to cached rows that say their age when temper is unreachable', () => {
		temperViews.teams = TEAMS;
		temperViews.teamsFetchedAt = STALE();
		temperViews.recent = { total: 214, rows: [ROW(1)] };
		temperViews.recentFetchedAt = STALE();
		const { container } = render(Views);
		const text = container.textContent ?? '';
		expect(text).toContain('temper-dev');
		expect(text).toMatch(/from cache, \d+m ago/);
	});

	it('says when a list is empty rather than hiding it', () => {
		temperViews.teams = [];
		temperViews.teamsFresh = true;
		const { container } = render(Views);
		expect(container.textContent).toContain('No teams.');
	});

	it('Show more widens the page through the store', async () => {
		temperViews.recent = { total: 214, rows: Array.from({ length: 10 }, (_, i) => ROW(i)) };
		temperViews.recentFresh = true;
		vi.mocked(invoke).mockImplementation(async (cmd: string) =>
			cmd === 'temper_recent_work'
				? { total: 214, rows: Array.from({ length: 20 }, (_, i) => ROW(i)) }
				: null
		);
		const { container } = render(Views);
		container.querySelector<HTMLButtonElement>('button')?.click();
		await vi.waitFor(() => expect(temperViews.recent?.rows).toHaveLength(20));
		expect(temperViews.recentLimit).toBe(20);
	});
});
