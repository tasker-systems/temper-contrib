import { describe, expect, it, vi } from 'vitest';
import { createRefResolver, type Resolution } from './refs';

const resolved = (id: string): Resolution => ({
	state: 'resolved', id, title: `title ${id}`, docType: 'goal', contextRef: '+temper-dev/contrib', decoratedRef: id
});

describe('createRefResolver', () => {
	it('coalesces refs asked for in one tick into one call, deduplicated', async () => {
		const batch = vi.fn(async (ids: string[]) => ids.map(resolved));
		const r = createRefResolver(batch);
		const [a, b, c] = await Promise.all([r.resolve('a'), r.resolve('b'), r.resolve('a')]);
		expect(batch).toHaveBeenCalledTimes(1);
		expect(batch).toHaveBeenCalledWith(['a', 'b']);
		expect([a.state, b.state, c.state]).toEqual(['resolved', 'resolved', 'resolved']);
	});

	it('caches answers, including unresolved ones', async () => {
		const batch = vi.fn(async (ids: string[]) =>
			ids.map((id): Resolution => (id === 'gone' ? { state: 'unresolved', id, reason: 'no resource at this reference' } : resolved(id)))
		);
		const r = createRefResolver(batch);
		await r.resolve('gone');
		expect((await r.resolve('gone')).state).toBe('unresolved');
		expect(batch).toHaveBeenCalledTimes(1);
	});

	it('does not cache a failed read, so the next ask tries again', async () => {
		let up = false;
		const batch = vi.fn(async (ids: string[]) => {
			if (!up) throw new Error('temper is not connected');
			return ids.map(resolved);
		});
		const r = createRefResolver(batch);
		const first = await r.resolve('a');
		expect(first).toEqual({ state: 'failed', id: 'a', message: 'temper is not connected' });
		up = true;
		expect((await r.resolve('a')).state).toBe('resolved');
		expect(batch).toHaveBeenCalledTimes(2);
	});

	it('reads a missing answer as failed, never as resolved or unresolved', async () => {
		const r = createRefResolver(async () => []);
		expect((await r.resolve('a')).state).toBe('failed');
	});
});
