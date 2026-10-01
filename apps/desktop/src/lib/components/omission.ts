/**
 * The omission sentence every bounded view ends with, composed from its numbers so no author words
 * it out of step with them. A view that is a page of something larger says which rows it shows and
 * what lies either side: `more` is the answer's own word that rows follow, never a guess from how
 * many rows arrived.
 */
export type Page = { offset: number; size: number; more: boolean };

export function omissionSentence(
	total: number,
	shown: number,
	scope: string,
	page?: Page | null
): string {
	if (!page) {
		const omitted = Math.max(0, total - shown);
		return omitted === 0
			? `All ${total} ${scope}.`
			: `${shown} of ${total} ${scope}; ${omitted} not shown.`;
	}
	const { offset, more } = page;
	if (offset === 0 && !more && shown === total) return `All ${total} ${scope}.`;
	const after = more ? Math.max(0, total - offset - shown) : 0;
	const either = [offset > 0 && `${offset} before this page`, more && `${after} after it`]
		.filter(Boolean)
		.join(', ');
	const rows = shown === 0 ? `None of ${total}` : `${offset + 1}–${offset + shown} of ${total}`;
	return either ? `${rows} ${scope}; ${either}.` : `${rows} ${scope}.`;
}
