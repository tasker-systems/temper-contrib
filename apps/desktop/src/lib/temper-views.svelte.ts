import { invoke } from '@tauri-apps/api/core';

/**
 * The temper reads the UI renders, cached with the moment each was read. The cache is
 * device-local and explicitly non-authoritative: it exists so that, with temper
 * unreachable, the views degrade to state that says its age — read-only, never a crash.
 * Every read goes through a Rust command; the page never speaks to temper itself.
 */

export type TemperIdentity = { displayName: string; handle: string; email?: string };

export type TemperTeam = { id: string; slug: string; name: string; description?: string | null };
export type TemperContext = {
	id: string;
	name: string;
	slug: string;
	ownerRef: string;
	resourceCount: number;
	updated: string;
};
export type TemperRecentRow = {
	id: string;
	decoratedRef: string;
	title: string;
	docType: string;
	contextRef?: string | null;
	updated: string;
};
export type TemperRecentPage = { total: number; rows: TemperRecentRow[] };

/** The recent-work list's first page, and how far each Show-more step extends it. */
export const RECENT_STEP = 10;

/** What a bounded list read narrows by (the `temper_list_resources` filter). */
export type ListFilter = {
	docType?: string;
	stage?: string;
	status?: string;
	contextRef?: string;
	/** `@me` for the person's own resources, or a profile handle. */
	owner?: string;
};

/** One bounded list's read: its page, when it landed, and whether it is this session's. */
export type ListView = {
	page: TemperRecentPage | null;
	fetchedAt: number | null;
	fresh: boolean;
	error: string;
	limit: number;
};

/** A list's first page, and how far each Show-more step extends it. */
export const LIST_STEP = 8;

const emptyList = (): ListView => ({
	page: null,
	fetchedAt: null,
	fresh: false,
	error: '',
	limit: LIST_STEP
});

/** The store's default context name until a setting says otherwise. The Rust core
 * owns the value (`DeviceSettings::DEFAULT_TEMPER_CONTEXT`); this is its echo, offered. */
export const DEFAULT_TEMPER_CONTEXT = 'temper-desktop';

/**
 * The person's own contexts — `@<handle>`, the `@me` target. Team-owned contexts,
 * even visible ones, are never the person context; neither is anyone else's. `null`
 * until the person and their contexts are both known.
 */
export function ownContextsOf(
	identity: TemperIdentity | null,
	contexts: TemperContext[] | null
): TemperContext[] | null {
	if (!identity?.handle || contexts === null) return null;
	return contexts
		.filter((c) => c.ownerRef === `@${identity.handle}`)
		.sort((a, b) => a.name.localeCompare(b.name));
}

const CACHE_KEY = 'temper-desktop.temper-cache.v1';

type PersistedCache = {
	identity?: TemperIdentity | null;
	identityFetchedAt?: number | null;
	teams?: TemperTeam[] | null;
	teamsFetchedAt?: number | null;
	contexts?: TemperContext[] | null;
	contextsFetchedAt?: number | null;
	recent?: TemperRecentPage | null;
	recentFetchedAt?: number | null;
	recentLimit?: number | null;
	lists?: Record<
		string,
		{ page: TemperRecentPage | null; fetchedAt: number | null; limit: number }
	>;
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

	teams = $state<TemperTeam[] | null>(null);
	teamsFetchedAt = $state<number | null>(null);
	teamsFresh = $state(false);
	teamsError = $state('');

	contexts = $state<TemperContext[] | null>(null);
	contextsFetchedAt = $state<number | null>(null);
	contextsFresh = $state(false);
	contextsError = $state('');

	recent = $state<TemperRecentPage | null>(null);
	recentFetchedAt = $state<number | null>(null);
	recentFresh = $state(false);
	recentError = $state('');
	/** How far into the recent-work ordering the current page reaches. */
	recentLimit = $state(RECENT_STEP);

	/** Bounded list reads by key — the left panel's entries, each its own read. */
	lists = $state<Record<string, ListView>>({});

	#initialised = false;

	constructor() {
		this.#loadCache();
	}

	/** Kicks the first reads once per session; components render, the store asks. */
	init(): void {
		if (this.#initialised) return;
		this.#initialised = true;
		void this.refreshProfile();
		void this.refreshTeams();
		void this.refreshContexts();
		void this.refreshRecent();
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

	async refreshTeams(): Promise<void> {
		try {
			this.teams = await invoke<TemperTeam[]>('temper_teams');
			this.teamsFetchedAt = Date.now();
			this.teamsFresh = true;
			this.#saveCache();
		} catch (e) {
			this.teamsError = String(e);
			this.teamsFresh = false;
		}
	}

	async refreshContexts(): Promise<void> {
		try {
			this.contexts = await invoke<TemperContext[]>('temper_contexts');
			this.contextsFetchedAt = Date.now();
			this.contextsFresh = true;
			this.#saveCache();
		} catch (e) {
			this.contextsError = String(e);
			this.contextsFresh = false;
		}
	}

	async refreshRecent(): Promise<void> {
		try {
			this.recent = await invoke<TemperRecentPage>('temper_recent_work', {
				limit: this.recentLimit,
				offset: 0
			});
			this.recentFetchedAt = Date.now();
			this.recentFresh = true;
			this.#saveCache();
		} catch (e) {
			this.recentError = String(e);
			this.recentFresh = false;
		}
	}

	/** Widens the recent-work page by one step and re-reads the same ordering. */
	async showMoreRecent(): Promise<void> {
		this.recentLimit += RECENT_STEP;
		await this.refreshRecent();
	}

	/** A list's read as it stands — nothing known yet is a list with no page. */
	list(key: string): ListView {
		return this.lists[key] ?? emptyList();
	}

	/** Reads one bounded list, newest update first; a failure keeps the cached page, with its age. */
	async refreshList(key: string, filter: ListFilter): Promise<void> {
		const current = this.lists[key] ?? emptyList();
		this.lists[key] = current;
		try {
			const page = await invoke<TemperRecentPage>('temper_list_resources', {
				filter,
				limit: current.limit,
				offset: 0
			});
			this.lists[key] = {
				page,
				fetchedAt: Date.now(),
				fresh: true,
				error: '',
				limit: current.limit
			};
			this.#saveCache();
		} catch (e) {
			this.lists[key] = { ...(this.lists[key] ?? current), fresh: false, error: String(e) };
		}
	}

	/** Widens one list's page by a step and re-reads the same ordering. */
	async showMoreList(key: string, filter: ListFilter): Promise<void> {
		const current = this.lists[key] ?? emptyList();
		this.lists[key] = { ...current, limit: current.limit + LIST_STEP };
		await this.refreshList(key, filter);
	}

	/** Test and reset seam: back to nothing known, cache included. */
	reset(): void {
		this.profileIdentity = null;
		this.profileFetchedAt = null;
		this.profileFresh = false;
		this.profileError = '';
		this.connected = null;
		this.connectError = null;
		this.teams = null;
		this.teamsFetchedAt = null;
		this.teamsFresh = false;
		this.teamsError = '';
		this.contexts = null;
		this.contextsFetchedAt = null;
		this.contextsFresh = false;
		this.contextsError = '';
		this.recent = null;
		this.recentFetchedAt = null;
		this.recentFresh = false;
		this.recentError = '';
		this.recentLimit = RECENT_STEP;
		this.lists = {};
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
			if (parsed.teams) this.teams = parsed.teams;
			if (typeof parsed.teamsFetchedAt === 'number') this.teamsFetchedAt = parsed.teamsFetchedAt;
			if (parsed.contexts) this.contexts = parsed.contexts;
			if (typeof parsed.contextsFetchedAt === 'number') {
				this.contextsFetchedAt = parsed.contextsFetchedAt;
			}
			if (parsed.recent) this.recent = parsed.recent;
			if (typeof parsed.recentFetchedAt === 'number') {
				this.recentFetchedAt = parsed.recentFetchedAt;
			}
			if (typeof parsed.recentLimit === 'number' && parsed.recentLimit > 0) {
				this.recentLimit = parsed.recentLimit;
			}
			if (parsed.lists && typeof parsed.lists === 'object') {
				for (const [key, cached] of Object.entries(parsed.lists)) {
					if (!cached || typeof cached !== 'object') continue;
					this.lists[key] = {
						page: cached.page ?? null,
						fetchedAt: typeof cached.fetchedAt === 'number' ? cached.fetchedAt : null,
						fresh: false,
						error: '',
						limit: typeof cached.limit === 'number' && cached.limit > 0 ? cached.limit : LIST_STEP
					};
				}
			}
		} catch {
			// a cache that cannot be read is no cache; the session starts on live reads alone
		}
	}

	#saveCache(): void {
		try {
			const persisted: PersistedCache = {
				identity: this.profileIdentity,
				identityFetchedAt: this.profileFetchedAt,
				teams: this.teams,
				teamsFetchedAt: this.teamsFetchedAt,
				contexts: this.contexts,
				contextsFetchedAt: this.contextsFetchedAt,
				recent: this.recent,
				recentFetchedAt: this.recentFetchedAt,
				recentLimit: this.recentLimit,
				lists: Object.fromEntries(
					Object.entries(this.lists).map(([key, l]) => [
						key,
						{ page: l.page, fetchedAt: l.fetchedAt, limit: l.limit }
					])
				)
			};
			localStorage.setItem(CACHE_KEY, JSON.stringify(persisted));
		} catch {
			// a cache that cannot be written costs the next cold start its fallback, no more
		}
	}
}

export const temperViews = new TemperViews();
