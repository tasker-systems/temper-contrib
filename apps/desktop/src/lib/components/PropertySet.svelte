<script lang="ts">
	/**
	 * A document's properties. Ported from temper-ui's PropertySet.svelte
	 * (tasker-systems/temper, packages/temper-ui/src/lib/components/vault/PropertySet.svelte, at
	 * ee12cd5) by copy-with-citation, re-pointed at theme roles. The read half is the port; the
	 * edit half follows the register's slice-3b clause: metadata saves are a separate channel
	 * that sends only the fields the person changed — nothing here may overwrite the other
	 * author's body, and nothing the body channel does may overwrite this.
	 *
	 * The two edit arms are separate acts, stated separately (OfferedChanges' direction):
	 * - a **state** the system defines (a task's stage, a goal's status) is changed against the
	 *   doc-type's own enum_fields, read — never restated here;
	 * - a **description** the reader attached is revised as text, keeping the type it had
	 *   (revisedValue).
	 *
	 * Managed keys lead, tinted toward the accent; a rule separates them from the open keys.
	 * Structured descriptions (lists, nested values) are excluded by decision and said out
	 * loud; removing a description takes a confirm, because it is a delete, not a restatement.
	 */
	import {
		type EditableKind,
		type PropertyRow,
		editableKind,
		reservedName,
		revisedValue
	} from '$lib/properties';
	import PropertyValue from './PropertyValue.svelte';
	import RegionState from './RegionState.svelte';

	let {
		rows,
		vocabularyUnread = false,
		refusal = null,
		mayDescribe = false,
		onsave
	}: {
		rows: PropertyRow[];
		/**
		 * The reader may change this resource, and the read that says which states its kind of
		 * work carries did not answer. Distinct from *this kind carries none*: both offer
		 * nothing, and only one of them is a degradation the reader should be able to see.
		 */
		vocabularyUnread?: boolean;
		/** The field whose last attempted change was refused, and what it was refused with. */
		refusal?: { field: string | null; message: string } | null;
		/** Whether the reader may attach a description the system has no field for. */
		mayDescribe?: boolean;
		/** Save the changed open-tier keys upward. Absent (tests, read-only), nothing offers. */
		onsave?: (changed: Record<string, unknown>, removing: string[]) => void;
	} = $props();

	// A description holding a list or a nested object is offered no control — excluded by
	// decision, because a real structured editor is a much larger surface and raw JSON would
	// require the reader to hold the system's own vocabulary. It is said out loud rather than
	// left as a silence, because it bites on the commonest keys there are (`tags`, `keywords`,
	// `relates_to` all hold lists) and a reader would otherwise read the missing control as a
	// bug in the one description they most wanted to change.
	let hasStructured = $derived(
		mayDescribe && rows.some((r) => !r.managed && editableKind(r.value) === null)
	);

	// The rule between the managed run and the open run. Managed keys always
	// lead (mergeProperties guarantees the order), so this is the first open row.
	let firstOpenKey = $derived(rows.find((r) => !r.managed)?.key ?? null);

	// The open run's editable rows: key → draft text. Seeded from the stored value and
	// captured per key on first edit — never a live re-derivation of an in-progress draft,
	// the same capture-once shape the editor's `seed` uses (a live binding would fight the
	// stored value on every keystroke).
	type Draft = { kind: 'string' | 'number' | 'boolean'; text: string };
	let edited = $state<Record<string, string>>({});
	// Descriptions standing to be removed. A remove is a delete — it takes a confirm.
	let removing = $state<Record<string, true>>({});

	// A key's draft: the person's edit while it diverges, the stored value once it matches
	// again — and the stored value for keys with no edit standing.
	function draftOf(row: PropertyRow): Draft {
		const kind = editableKind(row.value);
		if (!kind) return { kind: 'string', text: String(row.value) };
		const held = edited[row.key];
		if (held === undefined || revisedValue(held, kind) === row.value) {
			return { kind, text: String(row.value) };
		}
		return { kind, text: held };
	}

	// Drop edits and removals whose keys are gone from the rows (a landed save re-reads).
	$effect(() => {
		const keys = new Set(rows.filter((r) => !r.managed).map((r) => r.key));
		const nextEdits: Record<string, string> = {};
		const nextRemoving: Record<string, true> = {};
		for (const [key, value] of Object.entries(edited)) if (keys.has(key)) nextEdits[key] = value;
		for (const key of Object.keys(removing)) if (keys.has(key)) nextRemoving[key] = true;
		if (Object.keys(nextEdits).length !== Object.keys(edited).length) edited = nextEdits;
		if (Object.keys(nextRemoving).length !== Object.keys(removing).length) removing = nextRemoving;
	});

	const dirtyFields = $derived(
		rows
			.filter((r) => !r.managed && editableKind(r.value) !== null)
			.map((r) => ({ row: r, draft: draftOf(r) }))
			.filter(({ row, draft }) => revisedValue(draft.text, draft.kind) !== row.value)
	);
	const dirty = $derived(dirtyFields.length > 0 || Object.keys(removing).length > 0);

	function toggleRemove(key: string): void {
		if (removing[key]) delete removing[key];
		else removing[key] = true;
	}

	function attach(form: HTMLFormElement): void {
		const data = new FormData(form);
		const name = String(data.get('name') ?? '').trim();
		const value = String(data.get('value') ?? '').trim();
		if (!name || !value || !onsave) return;
		const refused = reservedName(name);
		if (refused) {
			refusal = { field: '', message: refused };
			return;
		}
		onsave({ [name]: value }, []);
	}

	function save(): void {
		if (!onsave || !dirty) return;
		const changed: Record<string, unknown> = {};
		for (const { row, draft } of dirtyFields) {
			changed[row.key] = revisedValue(draft.text, draft.kind);
		}
		onsave(changed, Object.keys(removing));
		removing = {};
		edited = {};
	}

	let attachName = $state('');
	let attachValue = $state('');
</script>

<div class="props">
	<p class="t-strip">Properties · {rows.length}</p>
	<dl>
		{#each rows as row (row.key)}
			{#if row.key === firstOpenKey}
				<hr />
			{/if}
			<div class="row" class:managed={row.managed}>
				<dt>{row.key}</dt>
				<dd>
					{#if row.managed || !mayDescribe}
						<PropertyValue value={row.value} />
					{:else if removing[row.key]}
						<span class="removing">removed on save</span>
						<button class="ctl" type="button" onclick={() => toggleRemove(row.key)}>Keep</button>
					{:else if editableKind(row.value) !== null}
						{@const d = draftOf(row)}
						<input
							class="ctl"
							type="text"
							aria-label={row.key}
							value={d.text}
							oninput={(e) => (edited[row.key] = e.currentTarget.value)}
						/>
						<button class="ctl" type="button" onclick={() => toggleRemove(row.key)}>Remove</button>
					{:else}
						<PropertyValue value={row.value} />
					{/if}
				</dd>
			</div>
		{/each}
	</dl>
	{#if mayDescribe}
		<form
			class="attach"
			onsubmit={(e) => {
				e.preventDefault();
				attach(e.currentTarget);
			}}
		>
			<input
				type="text"
				placeholder="name"
				aria-label="New description — name"
				autocomplete="off"
				spellcheck="false"
				required
				bind:value={attachName}
			/>
			<input
				type="text"
				placeholder="value"
				aria-label="New description — value"
				autocomplete="off"
				spellcheck="false"
				required
				bind:value={attachValue}
			/>
			<button type="submit">Attach</button>
		</form>
		{#if refusal && refusal.field === '' && refusal.message}
			<p class="err" role="alert">{refusal.message}</p>
		{/if}
	{/if}
	{#if hasStructured}
		<p class="unread">Descriptions holding lists or nested values are not editable here.</p>
	{/if}
	{#if vocabularyUnread}
		<p class="unread" role="status">
			Could not read which states this kind of work carries, so none are offered.
		</p>
	{/if}
	{#if refusal && refusal.field === null}
		<p class="unread" role="alert">{refusal.message}</p>
	{/if}
	{#if dirty}
		<div class="actions">
			{#if dirtyFields.length}
				<span class="count"
					>{dirtyFields.length} changed{Object.keys(removing).length
						? `, ${Object.keys(removing).length} removed`
						: ''}</span
				>
			{:else}
				<span class="count">{Object.keys(removing).length} removed</span>
			{/if}
			<button class="ctl save" type="button" onclick={save} disabled={!dirty}>Save</button>
		</div>
	{/if}
</div>

<style>
	.props {
		padding: 0.8rem 1rem 0.9rem;
		border: 1px solid var(--tp-rule);
		border-radius: var(--tp-radius-chip);
		background: var(--tp-surface);
	}
	.t-strip {
		margin: 0 0 0.5rem;
	}
	dl {
		margin: 0;
	}
	.row {
		display: grid;
		grid-template-columns: 9rem 1fr;
		gap: 0.6rem;
		padding: 0.15rem 0;
		align-items: start;
	}
	dt {
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
		overflow-wrap: anywhere;
	}
	dd {
		margin: 0;
		min-width: 0;
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.managed dt {
		color: var(--tp-accent);
	}
	.ctl {
		font: 0.75rem var(--tp-font-doing);
		color: var(--tp-text);
		background: var(--tp-surface);
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		padding: 0.1rem 0.45rem;
	}
	input.ctl {
		flex: 1;
		min-width: 8rem;
	}
	button.ctl:hover {
		border-color: var(--tp-accent-line);
		background: var(--tp-accent-wash);
	}
	button.ctl:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.save {
		border-color: var(--tp-accent-line);
	}
	.removing {
		font: italic 0.75rem var(--tp-font-doing);
		color: var(--tp-danger);
	}
	.attach {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-top: 0.6rem;
	}
	.attach input {
		font: 0.75rem var(--tp-font-doing);
		color: var(--tp-text);
		background: var(--tp-surface);
		border: 1px solid var(--tp-rule-strong);
		border-radius: var(--tp-radius-chip);
		padding: 0.1rem 0.45rem;
	}
	.attach input:first-child {
		width: 9rem;
		flex: none;
	}
	.attach input:last-of-type {
		flex: 1;
		min-width: 8rem;
	}
	.err {
		font: 0.75rem var(--tp-font-doing);
		color: var(--tp-danger);
		margin: 0.4rem 0 0;
	}
	.unread {
		font: italic 0.82rem var(--tp-font-reading);
		color: var(--tp-text-subtle);
		margin: 0.5rem 0 0;
	}
	.actions {
		display: flex;
		gap: 0.7rem;
		align-items: center;
		margin-top: 0.6rem;
	}
	.count {
		font: 0.72rem var(--tp-font-doing);
		color: var(--tp-text-subtle);
	}
	hr {
		margin: 0.45rem 0;
		border: 0;
		border-top: 1px dashed var(--tp-rule-strong);
	}
</style>