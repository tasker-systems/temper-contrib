// The piece's state is set directly on the store singleton; `invoke` is mocked so a
// mount-time refresh cannot race the words a test preloads.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import { invoke } from '@tauri-apps/api/core';
import { render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { temperViews } from '../temper-views.svelte';
import TemperProfile from './TemperProfile.svelte';

/** Ten minutes before the test clock — old enough that the age words name minutes. */
const STALE = () => Date.now() - 10 * 60 * 1000;

const describeFn = (name: string, fn: () => void) => describe(name, fn);

describeFn('TemperProfile', () => {
	beforeEach(() => {
		vi.mocked(invoke).mockClear();
		temperViews.reset();
	});

	it('renders the identity temper declares, as words', () => {
		temperViews.profileIdentity = { displayName: 'Ada Lovelace', handle: 'ada' };
		temperViews.profileFetchedAt = Date.now();
		temperViews.connected = true;
		const { container } = render(TemperProfile);
		const text = container.textContent ?? '';
		expect(text).toContain('Ada Lovelace');
		expect(text).toContain('@ada');
		expect(container.querySelector('pre')).toBeNull();
		expect(container.querySelector('code')).toBeNull();
	});

	it('renders words for connection state temper names', () => {
		temperViews.connected = false;
		temperViews.connectError = 'no credentials at ~/.temper';
		const { container } = render(TemperProfile);
		const text = container.textContent ?? '';
		expect(text).toContain('Not connected');
		expect(text).toContain('no credentials at ~/.temper');
	});

	it('never renders a payload — identity is words, never JSON', () => {
		temperViews.profileIdentity = { displayName: 'Ada Lovelace', handle: 'ada' };
		temperViews.profileFetchedAt = Date.now();
		temperViews.connected = true;
		const { container } = render(TemperProfile);
		const text = container.textContent ?? '';
		expect(text).not.toContain('{');
		expect(text).not.toContain('display_name');
		expect(text).not.toContain('avatar_url');
	});

	it('renders nothing for identity temper has not declared', () => {
		temperViews.profileIdentity = null;
		temperViews.profileFetchedAt = null;
		temperViews.connected = true;
		temperViews.profileError = '';
		const { container } = render(TemperProfile);
		const text = (container.textContent ?? '').trim();
		expect(text).not.toContain('@');
		expect(text).toContain('identity not read');
	});

	it('degrades to cached identity that says its age when temper is unreachable', () => {
		temperViews.profileIdentity = { displayName: 'Ada Lovelace', handle: 'ada' };
		temperViews.profileFetchedAt = STALE();
		temperViews.connected = false;
		const { container } = render(TemperProfile);
		const text = container.textContent ?? '';
		expect(text).toContain('Ada Lovelace');
		expect(text).toMatch(/from cache, \d+m ago/);
		expect(text).toContain('Not connected');
	});

	it('survives nothing cached and nothing known — unknown renders nothing, not a guess', () => {
		temperViews.reset();
		const { container } = render(TemperProfile);
		expect((container.textContent ?? '').trim()).toBe('');
		expect(container.querySelector('pre')).toBeNull();
	});
});
