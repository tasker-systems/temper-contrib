import { invoke } from '@tauri-apps/api/core';

/**
 * The temper reads the UI renders, cached with the moment each was read. The cache is
 * device-local and explicitly non-authoritative: it exists so that, with temper
 * unreachable, the views degrade to state that says its age — read-only, never a crash.
 * Every read goes through a Rust command; the page never speaks to temper itself.
 */

export type TemperIdentity = { displayName: string; handle: string; email?: string };

const CACHE_KEY = 'temper-desktop.temper-cache.v1';

type PersistedCache = {
	identity?: TemperIdentity | null;
	identityFetchedAt?: number | null;
};

/** How long ago a cached read landed, as words. Not ticking — the age is said when rendered. */
export function ageWords(fetchedAt: number, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** The identity fields temper declares, from the profile read's wire shape (snake_case). */
function projectIdentity(raw: Record<string, unknown>): TemperIdentity | null {
	const displayName = typeof raw.display_name === 'string' ? raw.display_name : '';
	if (!displayName) return null;
	const handle = typeof raw.slug === 'string' ? raw.slug : '';
	const email = typeof raw.email === 'string' && raw.email ? raw.email : undefined;
	return email ? { displayName, handle, email } : { displayName, handle };
}

class TemperViews {
	/** The person's identity as temper last declared it, and when that read landed. */
	profileIdentity = $state<TemperIdentity | null>(null);
	profileFetchedAt = $state<number | null>(null);
	/** False until a read succeeds in this session — a rendered cache is labeled with its age. */
	profileFresh = $state(false);
	profileError = $state('');
	/** `null` until the connection has been asked; unknown is not "not connected". */
	connected = $state<boolean | null>(null);
	connectError = $state<string | null>(null);

	#initialised = false;

	constructor() {
		this.#loadCache();
	}

	/** Kicks the first reads once per session; components render, the store asks. */
	init(): void {
		if (this.#initialised) return;
		this.#initialised = true;
		void this.refreshProfile();
	}

	async refreshProfile(): Promise<void> {
		try {
			const status = await invoke<{ connected: boolean; error: string | null }>(
				'temper_connection_status'
			);
			this.connected = status.connected;
			this.connectError = status.error;
			if (!status.connected) return; // the cached identity stands, labeled with its age
			const raw = await invoke<Record<string, unknown>>('temper_whoami');
			const identity = projectIdentity(raw ?? {});
			if (identity) {
				this.profileIdentity = identity;
				this.profileFetchedAt = Date.now();
				this.#saveCache();
			}
			this.profileFresh = identity !== null;
		} catch (e) {
			this.profileError = String(e);
			this.profileFresh = false;
		}
	}

	/** Test and reset seam: back to nothing known, cache included. */
	reset(): void {
		this.profileIdentity = null;
		this.profileFetchedAt = null;
		this.profileFresh = false;
		this.profileError = '';
		this.connected = null;
		this.connectError = null;
		try {
			localStorage.removeItem(CACHE_KEY);
		} catch {
			// storage unavailable; the in-memory reset stands
		}
	}

	#loadCache(): void {
		try {
			const raw = localStorage.getItem(CACHE_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw) as PersistedCache;
			if (parsed.identity) this.profileIdentity = parsed.identity;
			if (typeof parsed.identityFetchedAt === 'number') {
				this.profileFetchedAt = parsed.identityFetchedAt;
			}
		} catch {
			// a cache that cannot be read is no cache; the session starts on live reads alone
		}
	}

	#saveCache(): void {
		try {
			const persisted: PersistedCache = {
				identity: this.profileIdentity,
				identityFetchedAt: this.profileFetchedAt
			};
			localStorage.setItem(CACHE_KEY, JSON.stringify(persisted));
		} catch {
			// a cache that cannot be written costs the next cold start its fallback, no more
		}
	}
}

export const temperViews = new TemperViews();
