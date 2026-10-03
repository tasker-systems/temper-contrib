/**
 * The shipped temper-workflows manifest, as the loader receives it: one fixture source for
 * every witness that takes the loaded path. Inlined in place from the repository's
 * `plugins/` — never copied — so a test that no longer sees the manifest the desktop ships
 * fails here, at the fixture, instead of lying green.
 */
import manifestText from '../../../../../../plugins/temper-workflows/plugin.json?raw';

export function pluginManifestText(): string {
	return manifestText;
}

/** The one package the desktop ships this build, as the scan command answers it: a loaded
 * entry, package whole, nothing refused. */
export function pluginPackages(): {
	package: { name: string; files: { path: string; text: string }[] } | null;
	error: string | null;
}[] {
	return [
		{
			package: {
				name: 'temper-workflows',
				files: [{ path: 'plugin.json', text: pluginManifestText() }]
			},
			error: null
		}
	];
}
