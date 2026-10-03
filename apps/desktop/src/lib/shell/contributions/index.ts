/**
 * The shell's contributions, held reactively: core first, then the plugin packages loaded
 * beside the app, and one sentence per package the loader refused. The holder reads its
 * packages through the plugin loader; enabling and disabling is the package-boundary build's.
 */
export { shellContributions } from './contributions.svelte';
