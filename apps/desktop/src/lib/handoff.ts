/**
 * The refused save's intent handoff (slice 5): what the room composes to hand the disagreement
 * to the ACP agent, and what it takes back.
 *
 * Ruled (Pete, 2026-09-28, [the plan's slice 5](https://github.com/tasker-systems/temper-artifacts/pull/48)):
 * - The send side is prompt text: the intent plus the base, draft and newer version as fenced
 *   sections inside the prompt's text block — ACP's baseline MUST-support content, no prompt
 *   capability asked. An agent that declares the `embeddedContext` prompt capability may get
 *   embedded-resource blocks; the desktop never needs them, because the material is text it
 *   already holds.
 * - The return path is the conversation reply: the agent's proposal arrives as transcript text.
 *   The desktop extracts the proposal from the turn that follows the handoff prompt and offers
 *   it as the person's draft on the newer base — the person reviews and saves through
 *   compare-and-save; only a reviewed save enters the document.
 * - A turn that ends with no proposal is said, never silent.
 */

/** The disagreement's material, as the room holds it at refusal time. */
export type HandoffMaterial = {
	/** The document's title, for the prompt's words. */
	title: string;
	/** The body the edit started from. */
	base: string;
	/** What the person had written. */
	draft: string;
	/** The body as it now reads — the other author's version. */
	newer: string;
};

/** The intent, as the person stated it: free text, plus at most one one-click intent. */
export type Intent = {
	freeText: string;
	/** `fold` — fold my changes into theirs; `keep` — keep mine, don't lose what they added. */
	oneClick: 'fold' | 'keep' | null;
};

export const ONE_CLICK_WORDS: Record<Exclude<Intent['oneClick'], null>, string> = {
	fold: 'fold my changes into theirs',
	keep: 'keep mine, don\u2019t lose what they added'
};

/** Whether anything would go to the agent: an empty intent hands over nothing worth reading. */
export function intentStated(intent: Intent): boolean {
	return intent.freeText.trim() !== '' || intent.oneClick !== null;
}

/** The intent, as words the agent reads: the one-click's phrase, then the free text. */
export function intentWords(intent: Intent): string {
	const parts: string[] = [];
	if (intent.oneClick) parts.push(ONE_CLICK_WORDS[intent.oneClick]);
	const free = intent.freeText.trim();
	if (free) parts.push(free);
	return parts.join(' — ');
}

/** One fenced section of the prompt's text, in markdown. */
function fenced(label: string, body: string): string {
	return [`### ${label}`, '', '```markdown', body, '```'].join('\n');
}

/** What the trail read answers, as `doc_history` returns it (the bounded, grouped view). */
export type TrailRead = {
	total: number;
	omitted: number;
	runs: {
		actorName: string;
		acts: number;
		firstAt: string;
		lastAt: string;
		events: { eventId: string; kind: string; occurredAt: string }[];
	}[];
};

/**
 * The trail since the base, as lines for the prompt: the events that happened to the document
 * between the open and the refusal — the other author's write among them. Events at or before
 * the base are the base's own history and are not the disagreement's material; the room asks
 * for the newest `bound` and stops there, naming what it omitted. Empty when nothing moved
 * after the base.
 */
export function trailSince(
	history: TrailRead,
	since: string,
	bound = 20
): { lines: string; omitted: number } {
	const sinceMs = Date.parse(since);
	const lines: string[] = [];
	let omitted = 0;
	for (const run of history.runs) {
		const fresh = run.events.filter((e) => Date.parse(e.occurredAt) > sinceMs);
		omitted += run.events.length - fresh.length;
		for (const event of fresh) {
			if (lines.length >= bound) {
				omitted += 1;
				continue;
			}
			lines.push(`- ${event.occurredAt} ${run.actorName} ${event.kind}`);
		}
	}
	return { lines: lines.join('\n'), omitted };
}

/**
 * The handoff prompt's text: what the person wants, then the three versions as fenced
 * sections, then the instruction that bounds the agent's answer. The proposal fence's
 * exact marker is what the return path parses — a turn ending with none is a disclosed
 * failure, not a guess.
 */
export function handoffPrompt(intent: Intent, material: HandoffMaterial, trail: string): string {
	const lines = [
		`I was editing "${material.title}" in temper, but the document changed since I opened it, so my save was refused. Here is what I intended, and the material:`,
		'',
		`Intent: ${intentWords(intent) || '(none stated — decide what serves the document)'}`,
		'',
		material.draft === material.base ? '(My draft is identical to the base.)' : null,
		fenced('What I had written (my draft)', material.draft),
		fenced('What the document reads now (the newer version)', material.newer),
		fenced('What the document read when I opened it (the base)', material.base),
		trail ? '' : null,
		trail ? 'What happened to it since I opened it:' : null,
		trail ? '' : null,
		trail,
		'',
		'Return your proposed reconciliation as ONE fenced markdown block that begins with ```proposal and ends with ``` — the body between the fences is exactly the document text you propose, whole. Change nothing outside it, and write nothing else inside it.'
	];
	return lines.filter((line) => line !== null).join('\n');
}

/** What the proposal fence opens with — the marker the prompt asked for. */
const PROPOSAL_OPEN = '```proposal';

/**
 * The proposed body inside a turn's reply: the text between the ```proposal fence and its
 * closing fence, dedented of nothing — the text is taken exactly. Null when the turn carried
 * no proposal: the caller says so rather than guessing.
 *
 * The scan takes the LAST fence: the agent may reason in fenced examples before proposing, and
 * the proposal is the turn's product, not its first code-shaped block.
 */
export function proposalFrom(text: string): string | null {
	const open = text.lastIndexOf(PROPOSAL_OPEN);
	if (open === -1) return null;
	const afterOpen = open + PROPOSAL_OPEN.length;
	// The opening fence may carry a language hint after the marker or a trailing newline.
	const bodyStart = text.indexOf('\n', afterOpen);
	if (bodyStart === -1) return null;
	const close = text.indexOf('\n```', bodyStart + 1);
	if (close === -1) return null;
	return text.slice(bodyStart + 1, close);
}
