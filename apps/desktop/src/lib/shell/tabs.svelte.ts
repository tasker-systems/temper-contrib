/**
 * The tab model: the only source of truth for where the person is. SvelteKit's router is not how
 * anyone moves between rooms — every move goes through one door, `open`.
 *
 * A tab is a trail of steps, each a subject seen through a lens, with a cursor into the trail.
 * Following a link pushes a step onto the active tab's trail; the way out walks back along it.
 * Home is the pinned first tab: it cannot be closed and has no trail to walk, so a link followed
 * from home opens a new tab rather than replacing home.
 *
 * Twelve tabs may be open beside home. Opening a thirteenth sets the least-recently-used tab
 * aside — unmounted, listed, and reopened with its trail intact — and says which. A tab whose
 * lens declines to leave (an unsaved draft) is never set aside.
 *
 * A room is left when its tab's step changes, when its tab closes or is set aside, and when the
 * person switches to another tab; listeners hear each leave once, with when the room was entered.
 *
 * Open tabs are a device fact: tabs, trails, cursors, the active tab, the set-aside tabs and each
 * step's last-known title persist to this device's storage, bounded and versioned. A store that cannot be read
 * yields the home tab alone, never an error. Restored tabs are not mounted — and read nothing —
 * until they are first shown.
 */
import type { TabHandle } from './lenses';
import { parseSubject, type Subject, subjectKey, subjectWords } from './subjects';

/** How many tabs may be open beside home. */
export const TAB_BOUND = 12;
/** How many set-aside tabs are remembered. Older ones drop off the end. */
export const SET_ASIDE_BOUND = 20;
/** How many steps back a tab's trail remembers. Older steps drop off the front. */
export const TRAIL_BOUND = 20;
export const HOME_TAB = 'home';

const STORE_KEY = 'temper-shell-tabs-v1';

export interface Step {
	/** Unique per step: a lens instance lives exactly as long as its step. */
	key: string;
	subject: Subject;
	/** The lens this step is seen through, once resolved or chosen. */
	lens: string | null;
	/** The last-known title — what the lens named the subject, persisted for the tab header. */
	title: string | null;
	/** The doc type, once a read has said — what the lens switcher offers depends on it. */
	docType: string | null;
	/** The decorated ref temper gave a resource, once read — what the agent is shown. */
	ref: string | null;
	/** The context the resource's own read named — what the palette's create command
	 *  is offered in, the same way a query's subject names its own. */
	context: string | null;
}

export interface Tab {
	id: string;
	steps: Step[];
	cursor: number;
	/** When the tab was last shown — which tab is least recently used. */
	usedAt: number;
}

/** A room left: a step change, a tab close, or a tab set aside. */
export type LeaveListener = (step: Step, openedAt: number, leftAt: number) => void;

type Guard = () => true | string;

let serial = 0;
const mint = (prefix: string) => `${prefix}${Date.now().toString(36)}-${(serial++).toString(36)}`;

const homeStep = (): Step => ({
	key: 'home-0',
	subject: { kind: 'place', place: 'home' },
	lens: 'core/home',
	title: 'home',
	docType: null,
	ref: null,
	context: null
});

const homeTab = (): Tab => ({ id: HOME_TAB, steps: [homeStep()], cursor: 0, usedAt: 0 });

/** The words a step goes by: its last-known title, else what its subject is called unread. */
export function stepTitle(step: Step): string {
	return step.title ?? subjectWords(step.subject);
}

function readStep(raw: unknown): Step | null {
	if (!raw || typeof raw !== 'object') return null;
	const s = raw as Record<string, unknown>;
	const subject = parseSubject(s.subject);
	if (!subject || typeof s.key !== 'string') return null;
	const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
	return {
		key: s.key,
		subject,
		lens: text(s.lens),
		title: text(s.title),
		docType: text(s.docType),
		ref: text(s.ref),
		context: text(s.context)
	};
}

function readTab(raw: unknown): Tab | null {
	if (!raw || typeof raw !== 'object') return null;
	const t = raw as Record<string, unknown>;
	if (typeof t.id !== 'string' || t.id === HOME_TAB || !Array.isArray(t.steps)) return null;
	const steps = t.steps
		.map(readStep)
		.filter((s): s is Step => s !== null)
		.slice(-TRAIL_BOUND);
	if (steps.length === 0) return null;
	const cursor =
		typeof t.cursor === 'number' && Number.isInteger(t.cursor)
			? Math.min(Math.max(t.cursor, 0), steps.length - 1)
			: steps.length - 1;
	const usedAt = typeof t.usedAt === 'number' && Number.isFinite(t.usedAt) ? t.usedAt : 0;
	return { id: t.id, steps, cursor, usedAt };
}

/** A stored list of tabs, each read on its own; what is not a tab is dropped, and ids are unique. */
function readTabs(raw: unknown, seen: Set<string>): Tab[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map(readTab)
		.filter((t): t is Tab => t !== null && !seen.has(t.id) && Boolean(seen.add(t.id)));
}

export class TabModel {
	tabs = $state<Tab[]>([homeTab()]);
	activeId = $state<string>(HOME_TAB);
	/** Tabs that have been shown this run. A tab mounts on first activation and stays mounted. */
	mounted = $state<Record<string, true>>({ [HOME_TAB]: true });
	/** What the last move did or refused, in words — shown in the tab strip, cleared by the next move. */
	notice = $state<string | null>(null);
	/** Tabs set aside to make room, most recently set aside first. Unmounted; trails intact. */
	setAside = $state<Tab[]>([]);

	#storage: Storage | null;
	#now: () => number;
	#guards = new Map<string, Guard>();
	#listeners = new Set<LeaveListener>();
	#openedAt = new Map<string, number>();

	constructor(storage: Storage | null, now: () => number = Date.now) {
		this.#storage = storage;
		this.#now = now;
		this.#restore();
	}

	get active(): Tab {
		return this.tabs.find((t) => t.id === this.activeId) ?? this.tabs[0];
	}

	/** The step a tab is showing. */
	current(tab: Tab): Step {
		return tab.steps[tab.cursor];
	}

	/** Tabs that count against the bound: every tab but home. */
	get openCount(): number {
		return this.tabs.length - 1;
	}

	/**
	 * Show a tab. Switching away from a tab leaves the room it was showing, and showing a tab enters
	 * the room at its cursor: a person working across two tabs is recorded in both.
	 */
	activate(id: string): void {
		const tab = this.tabs.find((t) => t.id === id);
		if (!tab) return;
		if (id !== this.activeId) {
			const previous = this.tabs.find((t) => t.id === this.activeId);
			if (previous) this.#left(this.current(previous));
			this.#entered(this.current(tab));
		}
		tab.usedAt = this.#now();
		this.activeId = id;
		this.mounted[id] = true;
		this.notice = null;
		this.#save();
	}

	/**
	 * The one door in. `here` pushes a step onto the active tab's trail; `new` opens a tab. Home is
	 * never replaced: a `here` from home opens a new tab, and opening home activates the pinned tab.
	 * With `focus: false` a `new` tab opens unfocused — the tab appears in the strip and nothing is
	 * mounted, entered or shown; the person's tab, trail and notice are untouched. It becomes a
	 * normal tab the first time it is activated. Answers whether the move happened; a refusal says
	 * why in `notice`.
	 */
	open(
		subject: Subject,
		options: { where?: 'here' | 'new'; lens?: string | null; focus?: boolean } = {}
	): boolean {
		if (subject.kind === 'place' && subject.place === 'home') {
			this.activate(HOME_TAB);
			return true;
		}
		const where = this.activeId === HOME_TAB ? 'new' : (options.where ?? 'here');
		const step: Step = {
			key: mint('s'),
			subject,
			lens: options.lens ?? null,
			title: null,
			docType: null,
			ref: null,
			context: null
		};

		if (where === 'here') {
			const tab = this.active;
			if (!this.#mayLeave(tab)) return false;
			this.#left(this.current(tab));
			tab.steps = [...tab.steps.slice(0, tab.cursor + 1), step].slice(-TRAIL_BOUND);
			tab.cursor = tab.steps.length - 1;
			this.#entered(step);
			this.notice = null;
			this.#save();
			return true;
		}

		const room = this.#makeRoom(subjectWords(subject));
		if (room === false) return false;
		const tab: Tab = { id: mint('t'), steps: [step], cursor: 0, usedAt: this.#now() };
		this.tabs.push(tab);
		if (options.focus === false) {
			this.notice = room;
			this.#save();
			return true;
		}
		this.activate(tab.id);
		this.notice = room;
		return true;
	}

	/**
	 * Focus a tab already showing this subject — open or set aside — else open it in a new tab,
	 * through `lens` when one is named. A tab already showing the subject keeps its own lens.
	 */
	focusOrOpen(subject: Subject, lens: string | null = null): boolean {
		const key = subjectKey(subject);
		const existing = this.tabs.find((t) => subjectKey(this.current(t).subject) === key);
		if (existing) {
			this.activate(existing.id);
			return true;
		}
		const aside = this.setAside.find((t) => subjectKey(this.current(t).subject) === key);
		if (aside) return this.reopen(aside.id);
		return this.open(subject, { where: 'new', lens });
	}

	/** Reopen a set-aside tab with its trail intact. It re-reads when shown, as any restored tab. */
	reopen(id: string): boolean {
		const tab = this.setAside.find((t) => t.id === id);
		if (!tab) return false;
		const room = this.#makeRoom(stepTitle(this.current(tab)));
		if (room === false) return false;
		this.setAside = this.setAside.filter((t) => t.id !== id);
		this.tabs.push(tab);
		this.activate(tab.id);
		this.notice = room;
		return true;
	}

	/**
	 * Make room for one more tab. Under the bound there is room already (`null`, nothing to say).
	 * At the bound the least-recently-used tab willing to leave is set aside, and the answer says
	 * which. When every tab declines, nothing is set aside, `false` is answered and the notice says
	 * why.
	 */
	#makeRoom(opening: string): string | null | false {
		if (this.openCount < TAB_BOUND) return null;
		const chosen = this.tabs
			.filter((t) => t.id !== HOME_TAB && t.id !== this.activeId)
			.sort((a, b) => a.usedAt - b.usedAt)
			.find((t) => this.#willLeave(t));
		if (!chosen) {
			this.notice = `${TAB_BOUND} tabs are open and none can be set aside without losing work — close one to open ${opening}.`;
			return false;
		}
		this.#left(this.current(chosen));
		this.tabs = this.tabs.filter((t) => t.id !== chosen.id);
		this.#guards.delete(chosen.id);
		delete this.mounted[chosen.id];
		this.setAside = [chosen, ...this.setAside].slice(0, SET_ASIDE_BOUND);
		return `Set aside ${stepTitle(this.current(chosen))} to open ${opening}.`;
	}

	canBack(tab: Tab): boolean {
		return tab.cursor > 0;
	}

	canForward(tab: Tab): boolean {
		return tab.cursor < tab.steps.length - 1;
	}

	back(id: string = this.activeId): boolean {
		return this.#move(id, -1);
	}

	forward(id: string = this.activeId): boolean {
		return this.#move(id, 1);
	}

	/** Close a tab. Home cannot be closed; a tab whose lens declines to leave stays, and says why. */
	close(id: string): boolean {
		if (id === HOME_TAB) return false;
		const index = this.tabs.findIndex((t) => t.id === id);
		if (index < 0) return false;
		const tab = this.tabs[index];
		if (!this.#mayLeave(tab)) return false;
		this.#left(this.current(tab));
		this.tabs.splice(index, 1);
		this.#guards.delete(id);
		delete this.mounted[id];
		if (this.activeId === id) {
			this.activate(this.tabs[Math.min(index, this.tabs.length - 1)].id);
		} else {
			this.#save();
		}
		return true;
	}

	/** See the same subject through another lens: same step, same trail, nothing re-read. */
	setLens(id: string, lens: string): void {
		const tab = this.tabs.find((t) => t.id === id);
		if (!tab) return;
		this.current(tab).lens = lens;
		this.#save();
	}

	/** The host resolved a step's lens (and, for a resource, learned its doc type, ref and context). */
	resolved(
		stepKey: string,
		lens: string,
		docType: string | null,
		ref: string | null = null,
		context: string | null = null
	): void {
		const step = this.#step(stepKey);
		if (!step) return;
		step.lens = lens;
		if (docType) step.docType = docType;
		if (ref) step.ref = ref;
		if (context) step.context = context;
		this.#save();
	}

	setTitle(stepKey: string, title: string): void {
		const step = this.#step(stepKey);
		if (!step || step.title === title) return;
		step.title = title;
		this.#save();
	}

	/** What a lens mounted at this step may ask of its tab. */
	handle(tabId: string, stepKey: string): TabHandle {
		return {
			setTitle: (title) => this.setTitle(stepKey, title),
			open: (subject, where = 'here') => {
				if (this.activeId !== tabId && where === 'here') this.activate(tabId);
				this.open(subject, { where });
			},
			beforeLeave: (guard) => {
				this.#guards.set(tabId, guard);
				return () => {
					if (this.#guards.get(tabId) === guard) this.#guards.delete(tabId);
				};
			}
		};
	}

	/**
	 * The window stopped being worked in (hidden, or closing): the room in view is left now, so the
	 * last place of work is known without waiting for the next move. Idempotent.
	 */
	pause(): void {
		this.#left(this.current(this.active));
	}

	/** The window is worked in again: the room in view is entered, unless it still is. */
	resume(): void {
		const step = this.current(this.active);
		if (!this.#openedAt.has(step.key)) this.#entered(step);
	}

	/** Be told when a room is left — a step change or a tab close. Returns the unsubscribe. */
	onLeave(listener: LeaveListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#step(key: string): Step | undefined {
		for (const tab of this.tabs) {
			const step = tab.steps.find((s) => s.key === key);
			if (step) return step;
		}
		return undefined;
	}

	#move(id: string, by: -1 | 1): boolean {
		const tab = this.tabs.find((t) => t.id === id);
		if (!tab) return false;
		const next = tab.cursor + by;
		if (next < 0 || next >= tab.steps.length) return false;
		if (!this.#mayLeave(tab)) return false;
		this.#left(this.current(tab));
		tab.cursor = next;
		this.#entered(this.current(tab));
		this.notice = null;
		this.#save();
		return true;
	}

	/** Whether a tab's lens would let it go — asked without saying anything when it would not. */
	#willLeave(tab: Tab): boolean {
		const answer = this.#guards.get(tab.id)?.();
		return answer === undefined || answer === true;
	}

	#mayLeave(tab: Tab): boolean {
		const answer = this.#guards.get(tab.id)?.();
		if (answer === undefined || answer === true) return true;
		this.notice = answer;
		return false;
	}

	#entered(step: Step): void {
		this.#openedAt.set(step.key, this.#now());
	}

	#left(step: Step): void {
		const openedAt = this.#openedAt.get(step.key);
		this.#openedAt.delete(step.key);
		if (openedAt === undefined) return;
		const leftAt = this.#now();
		for (const listener of this.#listeners) listener(step, openedAt, leftAt);
	}

	#restore(): void {
		let raw: string | null = null;
		try {
			raw = this.#storage?.getItem(STORE_KEY) ?? null;
		} catch {
			// The store is unreadable: home alone.
		}
		if (raw) {
			try {
				const stored = JSON.parse(raw) as {
					v?: unknown;
					active?: unknown;
					tabs?: unknown;
					setAside?: unknown;
				};
				if (stored.v === 1 && Array.isArray(stored.tabs)) {
					const seen = new Set<string>();
					const tabs = readTabs(stored.tabs, seen).slice(0, TAB_BOUND);
					this.tabs = [homeTab(), ...tabs];
					this.setAside = readTabs(stored.setAside, seen).slice(0, SET_ASIDE_BOUND);
					const active = typeof stored.active === 'string' ? stored.active : HOME_TAB;
					this.activeId = this.tabs.some((t) => t.id === active) ? active : HOME_TAB;
				}
			} catch {
				// What was stored is not a tab list: home alone.
			}
		}
		this.mounted = { [this.activeId]: true };
		// Only the room in view has been entered: a tab restored in the background is entered when
		// it is first shown, never as if it had been open since launch.
		this.#entered(this.current(this.active));
	}

	#save(): void {
		try {
			this.#storage?.setItem(
				STORE_KEY,
				JSON.stringify({
					v: 1,
					active: this.activeId,
					tabs: this.tabs.filter((t) => t.id !== HOME_TAB),
					setAside: this.setAside
				})
			);
		} catch {
			// A store that cannot be written does not fail the move it records.
		}
	}
}

function deviceStorage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** The window's tab model. */
export const tabs = new TabModel(deviceStorage());
