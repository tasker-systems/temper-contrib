/**
 * View actions: what a rendered component asks of the host that mounted it — the next page, a
 * different order — and never a write. A component declares its actions in the catalog file
 * beside its props; the host hands TemperView a handler for each it serves. A spec names none and
 * cannot bind one: json-render's own action channel (and its built-in state writes) stays
 * unreachable, because `on` is refused at the door.
 *
 * A control is drawn only when its action is handled — a pager that pages nothing, or a header
 * that sorts nothing, would overstate itself.
 */
import { getContext, setContext } from 'svelte';
import { VIEW_ACTIONS } from './catalog';

/** `Component.action` → what the host does with the action's params. */
export type ViewActionHandlers = Record<string, (params: Record<string, unknown>) => void>;

export interface ViewActions {
	/** Whether the host handles this component's action. */
	handles(component: string, action: string): boolean;
	/** Route the action to the host, its params checked against the catalog's declaration. */
	act(component: string, action: string, params: Record<string, unknown>): void;
}

const KEY = Symbol('temper-view-actions');

/** Every handler a host passes must name an action the catalog declares, or it is a mistake. */
export function undeclaredActions(handlers: ViewActionHandlers): string[] {
	return Object.keys(handlers).filter((name) => !VIEW_ACTIONS.has(name));
}

/** The host's handlers, read through `handlers()` so a host may replace them without a remount. */
export function viewActions(handlers: () => ViewActionHandlers): ViewActions {
	return {
		handles: (component, action) =>
			Object.hasOwn(handlers(), `${component}.${action}`) &&
			VIEW_ACTIONS.has(`${component}.${action}`),
		act(component, action, params) {
			const name = `${component}.${action}`;
			const schema = VIEW_ACTIONS.get(name);
			if (!schema || !Object.hasOwn(handlers(), name)) return;
			const checked = schema.safeParse(params);
			if (!checked.success) throw new Error(`${name}: params do not match the catalog`);
			handlers()[name](checked.data as Record<string, unknown>);
		}
	};
}

const NONE: ViewActions = { handles: () => false, act: () => {} };

export function setViewActions(actions: ViewActions): void {
	setContext(KEY, actions);
}

/** The host's view actions, or none — a component rendered outside a host handles nothing. */
export function getViewActions(): ViewActions {
	return getContext<ViewActions | undefined>(KEY) ?? NONE;
}
