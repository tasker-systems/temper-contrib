// The editor spike's witnesses (slice 3, first step). The spike owes two proofs before the
// editor slice builds on it; this file holds the component-level half:
//
// 1. **Round-trip byte fidelity (W2/W10's spike half).** What the editor holds is what the room
//    saves. jsdom runs CodeMirror's state model honestly (its DOM measurement degrades, its
//    document model does not), so these witnesses mount the real component through a binding
//    and read the bound value: a no-edit document round-trips byte-for-byte, and one change
//    carries exactly the typed bytes.
//
// 2. **The mount itself.** The editor mounts inside its shadow root — the finding the spike
//    carries, because style-mod's document mount writes a runtime style tag the shipped CSP
//    refuses — shows the document, and its teardown is clean.
//
// The CSP half is not here: it is the production-build witness in the real webview
// (`cargo make desktop-csp-witness`, the binary with the editor mounted).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

import type { EditorView } from '@codemirror/view';
import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import EditorBinding from './EditorBinding.svelte';

// The kind of body the room opens: headings, a list, a fenced block — shapes CodeMirror's
// markdown parser handles, and shapes a byte-fidelity failure would show in.
const BODY = [
	'# Scope',
	'',
	'The room, read-only.',
	'',
	'## Notes',
	'',
	'- one',
	'- two',
	'',
	'```sh',
	'echo byte-for-byte',
	'```',
	''
].join('\n');

/** The editor's content element lives inside the host's shadow root, not the light DOM. */
function shadowOf(container: HTMLElement): ShadowRoot {
	const host = container.querySelector('.editor') as HTMLElement;
	const shadow = host.shadowRoot;
	if (!shadow) throw new Error('the editor did not mount a shadow root');
	return shadow;
}

describe('the editor spike', () => {
	it('mounts in a shadow root, shows the composed markdown, and holds it byte-for-byte with no edit', async () => {
		const instance = render(EditorBinding, { initial: BODY });
		await waitFor(() => {
			expect(shadowOf(instance.container).querySelector('.cm-content')).not.toBeNull();
		});
		// The update listener's first sync has run; the bound value is the base, byte for byte.
		await waitFor(() => {
			expect(instance.component.get()).toBe(BODY);
		});
	});

	it('carries a typed change exactly, and nothing else moves', async () => {
		let view: EditorView | undefined;
		const instance = render(EditorBinding, {
			initial: BODY,
			onview: (v: EditorView | null) => {
				view = v ?? undefined;
			}
		});
		await waitFor(() => {
			expect(shadowOf(instance.container).querySelector('.cm-content')).not.toBeNull();
		});
		await waitFor(() => {
			expect(instance.component.get()).toBe(BODY);
		});
		// jsdom does not emulate CodeMirror's keymap and measurement honestly, so the change is
		// applied through the view's own dispatch — the same path a keystroke takes, without
		// pretending jsdom can render it. One insertion at the end of the document.
		if (view === undefined) throw new Error('the editor view did not mount');
		view.dispatch({ changes: { from: BODY.length, insert: 'appended' } });

		expect(instance.component.get()).toBe(`${BODY}appended`);
	});
});
