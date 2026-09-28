/**
 * The hub writer's surface half: every resource room the person leaves is reported to the core,
 * which queues it and commits to the hub in coalesced batches (`hub_note_left`; see
 * `src-tauri/src/hub_queue.rs`). Nothing here waits on the network, and a refusal — a room passed
 * through too quickly to be a place of work — is the core's to decide and this module's to ignore.
 *
 * The window going out of use (hidden, or closing) leaves the room in view, so the last place of
 * work is known without waiting for the next move; coming back enters it again.
 */
import { invoke } from '@tauri-apps/api/core';
import { type Step, type TabModel, tabs } from './tabs.svelte';

/** The lens a resource room is recorded under when it has not been resolved yet. */
const DEFAULT_ROOM = 'core/document';

export type HubLeave = { resource: string; room: string; openedAt: string; leftAt: string };

/** The leave a step becomes, or `null` for anything that is not a resource room. */
export function leaveOf(step: Step, openedAt: number, leftAt: number): HubLeave | null {
	if (step.subject.kind !== 'resource') return null;
	return {
		resource: step.subject.id,
		room: step.lens ?? DEFAULT_ROOM,
		openedAt: new Date(openedAt).toISOString(),
		leftAt: new Date(leftAt).toISOString()
	};
}

type Note = (leave: HubLeave) => Promise<unknown>;

const noteToCore: Note = (leave) => invoke('hub_note_left', { leave });

/**
 * Starts reporting leaves from a tab model. Returns the function that stops. `target` is where the
 * window's visibility and page-hide events are heard; absent (tests, SSR), only moves are reported.
 */
export function startHubWriter(
	model: TabModel,
	note: Note = noteToCore,
	target: { window?: Window; document?: Document } = {
		window: typeof window === 'undefined' ? undefined : window,
		document: typeof document === 'undefined' ? undefined : document
	}
): () => void {
	const stopLeave = model.onLeave((step, openedAt, leftAt) => {
		const leave = leaveOf(step, openedAt, leftAt);
		// A refused leave is not a failure the person needs to hear about.
		if (leave) note(leave).catch(() => {});
	});

	const { window: win, document: doc } = target;
	const onVisibility = () => {
		if (!doc) return;
		if (doc.visibilityState === 'hidden') model.pause();
		else model.resume();
	};
	const onPageHide = () => model.pause();
	doc?.addEventListener('visibilitychange', onVisibility);
	win?.addEventListener('pagehide', onPageHide);

	return () => {
		stopLeave();
		doc?.removeEventListener('visibilitychange', onVisibility);
		win?.removeEventListener('pagehide', onPageHide);
	};
}

let started = false;

/** The window's writer, started once; the layout calls it, and so may any surface. */
export function initHubWriter(): void {
	if (started) return;
	started = true;
	startHubWriter(tabs);
}
