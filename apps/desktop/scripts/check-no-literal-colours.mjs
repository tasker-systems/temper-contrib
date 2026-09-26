// Fails if any component or stylesheet under src/ carries a literal colour. Colours come from
// theme roles (`var(--tp-*)`, `tp-` utilities) so every theme restyles everything; a literal is a
// value no theme can reach. Comments are ignored.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../src', import.meta.url).pathname;
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(|\b(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink)\b(?=\s*[;})'"])/g;

function* files(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* files(path);
		else if (/\.(svelte|css)$/.test(name)) yield path;
	}
}

// Blank out every `open … close` span, keeping its newlines so reported line numbers stay true.
// A scan rather than a regex replace: an unterminated comment blanks the rest of the file instead
// of leaving a fragment behind.
function blank(text, open, close) {
	let out = '';
	let i = 0;
	for (;;) {
		const start = text.indexOf(open, i);
		if (start < 0) return out + text.slice(i);
		out += text.slice(i, start);
		const end = text.indexOf(close, start + open.length);
		const stop = end < 0 ? text.length : end + close.length;
		out += text.slice(start, stop).replace(/[^\n]/g, '');
		if (end < 0) return out;
		i = stop;
	}
}

const stripComments = (text) =>
	blank(blank(text, '/*', '*/'), '<!--', '-->').replace(/^\s*\/\/.*$/gm, '');

let failures = 0;
for (const path of files(ROOT)) {
	const lines = stripComments(readFileSync(path, 'utf8')).split('\n');
	lines.forEach((line, i) => {
		for (const m of line.matchAll(LITERAL)) {
			// An id or anchor like `#r0` is not a colour; only hex-shaped runs of 3/4/6/8 count.
			if (m[0].startsWith('#') && ![4, 5, 7, 9].includes(m[0].length)) continue;
			console.error(`${relative(ROOT, path)}:${i + 1}: literal colour ${m[0]} — use a theme role`);
			failures++;
		}
	});
}
if (failures) {
	console.error(`\n${failures} literal colour(s). Components read --tp-* roles only (themes/README.md).`);
	process.exit(1);
}
console.log('ok: no literal colours under src/');
