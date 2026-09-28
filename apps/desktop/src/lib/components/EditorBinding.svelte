<script lang="ts">
	/** Test harness: binds the editor's value so a test reads the two-way flow honestly. */
	import type { EditorView } from '@codemirror/view';
	import DocumentEditor from './DocumentEditor.svelte';

	let { initial, onview }: { initial: string; onview?: (view: EditorView | null) => void } =
		$props();
	// The initial capture is deliberate: the editor edits in place from its initial document,
	// and nothing re-seeds it. A derived re-seed would clobber the person's draft.
	// svelte-ignore state_referenced_locally
	let value = $state(initial);

	// Expose the bound value to the test: `render` hands the instance's exports back on
	// `instance.component`, and this names the read.
	export const get = () => value;
</script>

<DocumentEditor initial={initial} bind:value {onview} />