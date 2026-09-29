/**
 * The shell's own panels: the left panel of ways in, and the command palette. Both close; the
 * left panel remembers open or closed per device (a versioned key, try/catch — a store that
 * cannot be written does not fail the panel it decorates), and once shown it stays mounted, so
 * reopening it re-reads nothing. It is closed by default: the room is the first thing the
 * window offers, and the ways in are one gesture away (the menu chip's entry). The palette is
 * never remembered open: it opens when asked.
 */
const WAYS_STORE = 'temper-ways-in-v1';

function readOpen(): boolean {
	try {
		const raw = localStorage.getItem(WAYS_STORE);
		return raw === null ? false : raw === 'true';
	} catch {
		return false;
	}
}

class ShellPanels {
	/** Whether the ways-in panel is showing. Closed until the person opens it. */
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
