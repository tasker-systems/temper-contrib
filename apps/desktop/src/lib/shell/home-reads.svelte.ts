/**
 * The reads home's sections share, made once per show. Home counts each time it is shown and
 * hands the count to every section; a section asks for a read with that count, and a read already
 * made for this show is answered from what landed, never asked again. Nothing here reads on a
 * timer or on hover.
 */
import { invoke } from '@tauri-apps/api/core';

/** One entry of the hub's recent work, as `hub_recent_work` answers it. */
export type RecentWorkEntry = {
	resource: string;
	/** The lens the room was seen through. */
	room: string;
	openedAt: string;
	leftAt: string;
	device: string;
};

export type RecentWorkView = {
	entries: RecentWorkEntry[];
	/** How many of the entries' facts are queued on this device and not yet committed. */
	queued: number;
	thisDevice?: string;
};

export type HomeRead<T> =
	| { state: 'arriving' }
	| { state: 'present'; data: T; fetchedAt: number }
	| { state: 'failed'; message: string };

class HomeReads {
	recent = $state<HomeRead<RecentWorkView>>({ state: 'arriving' });
	#recentShow = -1;

	/** The hub's recent work for this show of home: read on the first ask of a show, then held. */
	readRecent(shown: number): void {
		if (shown === this.#recentShow) return;
		this.#recentShow = shown;
		if (this.recent.state !== 'present') this.recent = { state: 'arriving' };
		invoke<RecentWorkView>('hub_recent_work').then(
			(data) => {
				if (shown === this.#recentShow)
					this.recent = { state: 'present', data, fetchedAt: Date.now() };
			},
			(e) => {
				if (shown !== this.#recentShow) return;
				// A read that failed after one landed keeps what landed; the section says its age.
				if (this.recent.state !== 'present') this.recent = { state: 'failed', message: String(e) };
			}
		);
	}

	/** Test seam: back to nothing read. */
	reset(): void {
		this.recent = { state: 'arriving' };
		this.#recentShow = -1;
	}
}

export const homeReads = new HomeReads();
