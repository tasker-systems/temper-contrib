import { invoke } from '@tauri-apps/api/core';
import { coercePreference, DEFAULT_PREFERENCE, resolveTheme, type ThemePreference } from './theme';

/**
 * The live theme state. The core store is the source; this is its reflection in the webview.
 * The layout applies `active` to the document, and the Appearance control edits `pref`
 * through `choose`.
 */
class ThemeStore {
	pref = $state<ThemePreference>(DEFAULT_PREFERENCE);
	systemDark = $state(true);
	active = $derived(resolveTheme(this.pref, this.systemDark));
	#initialised = false;

	init(): void {
		if (this.#initialised) return;
		this.#initialised = true;
		this.#load();
		this.#watchSystem();
	}

	async #load(): Promise<void> {
		try {
			const settings = await invoke<{ theme?: unknown }>('settings_get');
			this.pref = coercePreference(settings.theme);
		} catch {
			// The store is unreachable (development in a plain browser, e.g.); the default stands.
		}
	}

	#watchSystem(): void {
		const query = matchMedia('(prefers-color-scheme: dark)');
		this.systemDark = query.matches;
		query.addEventListener('change', (event) => (this.systemDark = event.matches));
	}

	async choose(next: ThemePreference): Promise<void> {
		this.pref = next;
		try {
			await invoke('settings_set_theme', { theme: next });
		} catch {
			// A preference that cannot be stored still applies for this session.
		}
	}
}

export const themeStore = new ThemeStore();
