/**
 * Resolving resource references for display. A ResourceRef shows what temper says the resource
 * is — never a title an author typed — so every ref goes through here.
 *
 * Refs asked for in the same tick are coalesced into one call. Answers are cached for the
 * session; a failed read is not, so the next ask tries again. Three outcomes, kept apart the way
 * the region vocabulary keeps empty apart from failed: `unresolved` is temper saying there is
 * nothing you can see at that id; `failed` is the read not completing, which verifies nothing.
 */
import { invoke } from '@tauri-apps/api/core';
import { getContext, setContext } from 'svelte';

export type Resolution =
	| {
			state: 'resolved';
			id: string;
			title: string;
			docType: string;
			contextRef: string | null;
			decoratedRef: string;
	  }
	| { state: 'unresolved'; id: string; reason: string }
	| { state: 'failed'; id: string; message: string };

export type ResolveBatch = (ids: string[]) => Promise<Resolution[]>;

export interface RefResolver {
	resolve(id: string): Promise<Resolution>;
	/** Where answers come from, said plainly — shown wherever fixtures could be mistaken for temper. */
	readonly source: 'temper' | 'fixtures';
}

export function createRefResolver(batch: ResolveBatch, source: RefResolver['source'] = 'temper'): RefResolver {
	const cache = new Map<string, Promise<Resolution>>();
	let queue: { id: string; settle: (r: Resolution) => void }[] = [];

	async function flush() {
		const waiting = queue;
		queue = [];
		const ids = [...new Set(waiting.map((w) => w.id))];
		let answers: Map<string, Resolution>;
		try {
			answers = new Map((await batch(ids)).map((r) => [r.id, r]));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			answers = new Map(ids.map((id) => [id, { state: 'failed', id, message }]));
		}
		for (const w of waiting) {
			const answer: Resolution = answers.get(w.id) ?? {
				state: 'failed',
				id: w.id,
				message: 'no answer came back for this reference'
			};
			if (answer.state === 'failed') cache.delete(w.id);
			w.settle(answer);
		}
	}

	return {
		source,
		resolve(id) {
			const hit = cache.get(id);
			if (hit) return hit;
			const pending = new Promise<Resolution>((settle) => {
				if (queue.length === 0) queueMicrotask(flush);
				queue.push({ id, settle });
			});
			cache.set(id, pending);
			return pending;
		}
	};
}

/** Resolution through the Rust core (`temper_resolve_refs`), which holds the temper connection. */
export const tauriResolver = createRefResolver((ids) => invoke<Resolution[]>('temper_resolve_refs', { ids }));

const KEY = Symbol('temper-ref-resolver');

export function setRefResolver(resolver: RefResolver): void {
	setContext(KEY, resolver);
}

export function getRefResolver(): RefResolver {
	return getContext<RefResolver | undefined>(KEY) ?? tauriResolver;
}
