/**
 * The shell's contributions, held reactively: core's own, plus whatever plugin packages load
 * beside the app. Core is always first — the holder is born with it, so a run where the scan
 * command never answers (a test, a non-Tauri harness) still renders core whole and never a
 * crash. `init` kicks the one scan per session; the packages' contributions are appended and
 * any refusal sentence is kept for the ways-in foot to name. The shell renders only once the
 * scan has settled, so its first sight of home and the panel is the whole set.
 */
import { invoke } from '@tauri-apps/api/core';
import type { Contribution } from '../lenses';
import { core } from './core';
import { loadContributions, type PackageSource } from './packages';

class ShellContributions {
	/** Every enabled contribution, in registration order — core first, packages after. */
	enabled = $state.raw<readonly Contribution[]>([core]);
	/** One sentence per refused package, for the ways-in foot. */
	refusals = $state.raw<string[]>([]);
	/** Whether the one scan has settled — the layout's gate on rendering the shell. */
	ready = $state(false);

	#loading: Promise<void> | null = null;

	/** Kicks the package scan once per session; components may render after `ready`. */
	init(): void {
		this.#loading ??= this.#load();
	}

	/** The scan, as a promise — for a caller that wants to wait on it. */
	settled(): Promise<void> {
		this.init();
		return this.#loading as Promise<void>;
	}

	async #load(): Promise<void> {
		try {
			const packages = await invoke<PackageSource[]>('plugin_packages');
			const { contributions, refusals } = loadContributions(packages ?? []);
			this.enabled = [core, ...contributions];
			this.refusals = refusals;
		} catch {
			// the core contribution stands alone, named by nothing and crashed by nothing
		} finally {
			this.ready = true;
		}
	}
}

export const shellContributions = new ShellContributions();
