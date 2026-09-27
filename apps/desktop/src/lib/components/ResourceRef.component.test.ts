// A reference is a link into the document room only once temper has answered for it: resolving,
// unresolved and failed references stay inert, so no link points at what temper did not name.
// The default resolver goes through `invoke`, mocked here; each case uses its own id because the
// resolver caches answers for the session.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { Resolution } from '$lib/refs';
import ResourceRef from './ResourceRef.svelte';

const id = (n: number) => `01a0e020-a6d7-7420-b924-${String(n).padStart(12, '0')}`;

function answering(answer: (asked: string) => Resolution | 'never' | 'throw'): void {
	vi.mocked(invoke).mockImplementation((async (_cmd: string, args: { ids: string[] }) => {
		const asked = args.ids[0];
		const a = answer(asked);
		if (a === 'never') return new Promise(() => {});
		if (a === 'throw') throw new Error('temper is not connected');
		return [a];
	}) as never);
}

const resolved = (asked: string): Resolution => ({
	state: 'resolved',
	id: asked,
	title: 'A document',
	docType: 'task',
	contextRef: '@me/contrib',
	decoratedRef: `a-document-${asked}`
});

describe('ResourceRef', () => {
	it('links a resolved reference into its room, at the address temper gave it', async () => {
		answering(resolved);
		const { container } = render(ResourceRef, { props: { id: id(1) } });
		await waitFor(() => expect(container.querySelector('a')).not.toBeNull());
		expect(container.querySelector('a')?.getAttribute('href')).toBe(`/r/a-document-${id(1)}`);
		expect(container.textContent).toContain('A document');
	});

	it('lets a room carry its walk into the link', async () => {
		answering(resolved);
		const { container } = render(ResourceRef, {
			props: { id: id(2), hrefFor: (ref: string) => `/r/${ref}?walk=here` }
		});
		await waitFor(() => expect(container.querySelector('a')).not.toBeNull());
		expect(container.querySelector('a')?.getAttribute('href')).toBe(
			`/r/a-document-${id(2)}?walk=here`
		);
	});

	it('stays inert while resolving', () => {
		answering(() => 'never');
		const { container } = render(ResourceRef, { props: { id: id(3), titleHint: 'a hint' } });
		expect(container.textContent).toContain('a hint');
		expect(container.querySelector('a')).toBeNull();
	});

	it('stays inert when temper answers there is nothing to see', async () => {
		answering((asked) => ({ state: 'unresolved', id: asked, reason: 'not found' }));
		const { container } = render(ResourceRef, { props: { id: id(4) } });
		await waitFor(() =>
			expect(container.textContent).toContain('Unresolved reference — not found')
		);
		expect(container.querySelector('a')).toBeNull();
	});

	it('stays inert when the read fails', async () => {
		answering(() => 'throw');
		const { container } = render(ResourceRef, { props: { id: id(5) } });
		await waitFor(() => expect(container.textContent).toContain('Reference unavailable'));
		expect(container.querySelector('a')).toBeNull();
	});
});
