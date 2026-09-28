/**
 * The shell's own panels: the left panel of ways in, and the command palette. Both close; the
 * left panel remembers open or closed per device (a versioned key, try/catch — a store that
 * cannot be written does not fail the panel it decorates), and once shown it stays mounted, so
 * reopening it re-reads nothing. The palette is never remembered open: it opens when asked.
 */
const WAYS_STORE = 'temper-ways-in-v1';

function readOpen(): boolean {
	try {
		const raw = localStorage.getItem(WAYS_STORE);
		return raw === null ? true : raw === 'true';
	} catch {
		return true;
	}
}

class ShellPanels {
	/** Whether the ways-in panel is showing. Open on first run. */
	waysOpen = $state<boolean>(readOpen());
	/** Whether it has ever been shown this run — it mounts, and reads, only once it has. */
	waysShown = $state<boolean>(this.waysOpen);
	paletteOpen = $state(false);

	setWaysOpen(open: boolean): void {
		this.waysOpen = open;
		if (open) this.waysShown = true;
		try {
			localStorage.setItem(WAYS_STORE, String(open));
		} catch {
			// the choice holds for this run
		}
	}

	setPaletteOpen(open: boolean): void {
		this.paletteOpen = open;
	}
}

export const shellPanels = new ShellPanels();
