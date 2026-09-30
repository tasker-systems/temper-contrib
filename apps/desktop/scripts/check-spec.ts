// Runs the webview's one gate, `checkSpec`, outside the webview: a spec as JSON on stdin, the
// check's result as JSON on stdout. The running-app witness answers presentations through this,
// so the check it exercises is the desktop's own, never a restatement.
import { checkSpec } from '../src/lib/catalog/catalog';

const input = await new Response(Bun.stdin.stream()).text();
const result = checkSpec(JSON.parse(input));
process.stdout.write(JSON.stringify(result.ok ? { ok: true } : result));
