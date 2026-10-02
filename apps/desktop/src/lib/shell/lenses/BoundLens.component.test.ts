// The bound lens's witnesses: each binding read asks for the subject it needs — a tagged
// listing for `resource-list`, a walk from the subject for `graph` — primes the ref resolver
// from the answer, and tells a read that failed from a view the core refused. `invoke` is
// mocked, and the ref resolver with it, so priming is observed directly.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

const primed: unknown[][] = [];
vi.mock('$lib/refs', () => ({
	getRefResolver: () => ({
		prime: (answers: unknown[]) => {
			primed.push(answers);
		},
		resolve: async (id: string) => ({
			state: 'unresolved',
			id,
			reason: 'the witness mocks the read'
		}),
		source: 'test'
	})
}));

import { invoke } from '@tauri-apps/api/core';
import { render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { core } from '../contributions/core';
import type { LensDecl, LensProps, TabHandle } from '../lenses';
import type { Subject } from '../subjects';
import BoundLens from './BoundLens.svelte';

const ID = '01a0f000-0000-7000-8000-00000000000a';
const CONTEXT = '+temper-dev/contrib';

const decl = (id: string): LensDecl => core.lenses.find((l) => l.id === id) as LensDecl;

/** The bound build of a core lens — every decl this witness mounts is one of the two bound ones. */
const bound = (id: string): Extract<LensDecl['build'], { state: 'bound' }> => {
	const build = decl(id).build;
	if (build.state !== 'bound') throw new Error(`${id} is not a bound lens`);
	return build;
};

const answer = {
	spec: {
		root: 't',
		elements: { t: { type: 'Text', props: { text: 'drawn' }, children: [] } }
	},
	refs: [
		{
			state: 'resolved',
			id: ID,
			title: 'A resource',
			docType: 'task',
			contextRef: null,
			decoratedRef: ID
		}
	]
};

const tab = (): TabHandle => ({ setTitle: vi.fn(), open: vi.fn(), beforeLeave: () => () => {} });

const props = (subject: Subject, lens: LensDecl): LensProps =>
	({ subject, lens, tab: tab() }) as LensProps;

beforeEach(() => {
	primed.length = 0;
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockResolvedValue(answer as never);
});

describe('the bound lens', () => {
	it('a graph binding on a resource walks it, depth 1', async () => {
		render(BoundLens, { props: props({ kind: 'resource', id: ID }, decl('core/graph')) });
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith('lens_resolve', {
				spec: bound('core/graph').spec,
				binding: { element: 'graph', read: 'graph' },
				subject: { kind: 'neighbourhood', id: ID, depth: 1 },
				view: { offset: 0 }
			})
		);
	});

	it('a graph binding on a neighbourhood walks from it', async () => {
		render(BoundLens, {
			props: props({ kind: 'neighbourhood', id: ID, depth: 1 }, decl('core/graph'))
		});
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith('lens_resolve', {
				spec: bound('core/graph').spec,
				binding: { element: 'graph', read: 'graph' },
				subject: { kind: 'neighbourhood', id: ID, depth: 1 },
				view: { offset: 0 }
			})
		);
	});

	it('a graph binding on a query asks the entry read at its context', async () => {
		render(BoundLens, { props: props({ kind: 'query', context: CONTEXT }, decl('core/graph')) });
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith('lens_resolve', {
				spec: bound('core/graph').spec,
				binding: { element: 'graph', read: 'graph' },
				subject: { kind: 'query', context: CONTEXT },
				view: { offset: 0 }
			})
		);
	});

	it('the table binding keeps the listing subject, tagged', async () => {
		render(BoundLens, {
			props: props(
				{ kind: 'query', context: CONTEXT, docType: 'task', text: 'graph' },
				decl('core/table')
			)
		});
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith('lens_resolve', {
				spec: bound('core/table').spec,
				binding: { element: 'table', read: 'resource-list' },
				subject: { kind: 'query', context: CONTEXT, docType: 'task', text: 'graph' },
				view: { offset: 0 }
			})
		);
	});

	it('primes the ref resolver from the answer, and renders the view it filled', async () => {
		const { container } = render(BoundLens, {
			props: props({ kind: 'resource', id: ID }, decl('core/graph'))
		});
		await vi.waitFor(() => expect(primed).toHaveLength(1));
		expect(primed[0]).toEqual(answer.refs);
		await vi.waitFor(() => expect(container.textContent).toContain('drawn'));
		expect(container.querySelector('.region.failed')).toBeNull();
	});

	it('a read that failed renders the refusal, never a partial view', async () => {
		vi.mocked(invoke).mockRejectedValue('temper is not connected');
		const { container } = render(BoundLens, {
			props: props({ kind: 'resource', id: ID }, decl('core/graph'))
		});
		const failed = await vi.waitFor(() => {
			const el = container.querySelector('.region.failed');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		expect(failed.textContent).toContain('temper is not connected');
	});

	it('a refused view is told apart from a failed read', async () => {
		vi.mocked(invoke).mockRejectedValue('the filled view was refused: bounds disagree');
		const { container } = render(BoundLens, {
			props: props({ kind: 'resource', id: ID }, decl('core/graph'))
		});
		await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
		expect(container.textContent).toContain('was read, but the view made from it was refused');
		expect(container.querySelector('.region.failed')).toBeNull();
	});
});
