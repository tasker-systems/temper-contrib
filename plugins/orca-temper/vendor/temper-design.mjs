// node_modules/@tasker-systems/temper-design/dist/ways-in.js
var WAY_IN_BOUND = 8;
var WAY_IN_ORDER = "most recently updated first";
var WAYS_IN = [
  {
    id: "goals",
    label: "goals",
    scope: "active goals of yours",
    filter: { docType: "goal", owner: "@me", status: "active" }
  },
  {
    id: "tasks",
    label: "in progress",
    scope: "tasks in progress of yours",
    filter: { docType: "task", owner: "@me", stage: "in-progress" }
  },
  {
    id: "sessions",
    label: "sessions",
    scope: "sessions of yours",
    filter: { docType: "session", owner: "@me" }
  }
];

// node_modules/@tasker-systems/temper-design/dist/handoff.js
var HANDOFF_LABEL = "latest handoff";
var NEXT_BOUND = 600;
var OPENER = /^(#{1,6})\s+/;
function heading(line) {
  const open = OPENER.exec(line);
  if (!open)
    return null;
  let text = line.slice(open[0].length).trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#")
    end--;
  text = text.slice(0, end).trimEnd();
  return { level: open[1].length, text };
}
function nextSection(markdown, bound = NEXT_BOUND) {
  const lines = markdown.split(/\r?\n/);
  let fence = false;
  let start = -1;
  let level = 0;
  let title = "";
  const body = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line))
      fence = !fence;
    const match = fence ? null : heading(line);
    if (start < 0) {
      if (match && /^next\b/i.test(match.text)) {
        start = i;
        level = match.level;
        title = match.text;
      }
      continue;
    }
    if (match && match.level <= level)
      break;
    body.push(line);
  }
  if (start < 0)
    return null;
  const text = body.join("\n").trim();
  if (!text)
    return null;
  if (text.length <= bound)
    return { heading: title, text, truncated: false };
  const cut = text.slice(0, bound);
  const atWord = cut.slice(0, Math.max(cut.lastIndexOf(" "), bound - 40));
  return { heading: title, text: `${atWord.trimEnd()}\u2026`, truncated: true };
}

// node_modules/@tasker-systems/temper-design/dist/omission.js
function omissionSentence(total, shown, scope, page) {
  if (!page) {
    const omitted = Math.max(0, total - shown);
    return omitted === 0 ? `All ${total} ${scope}.` : `${shown} of ${total} ${scope}; ${omitted} not shown.`;
  }
  const { offset, more } = page;
  if (offset === 0 && !more && shown === total)
    return `All ${total} ${scope}.`;
  const before = Math.min(offset, total);
  const after = Math.max(0, total - offset - shown);
  const afterClause = after > 0 ? `${after} after it` : more ? "more after it" : null;
  const either = [before > 0 && `${before} before this page`, afterClause].filter(Boolean).join(", ");
  const rows = shown === 0 ? `None of ${total}` : `${offset + 1}\u2013${offset + shown} of ${total}`;
  return either ? `${rows} ${scope}; ${either}.` : `${rows} ${scope}.`;
}
function uncountedSentence(shown, scope, cursor) {
  if (!cursor)
    return `${shown} ${scope}; more not reported.`;
  if (!("first" in cursor))
    return cursor.more ? `${shown} ${scope}; more not shown.` : `All ${shown} ${scope}.`;
  const { first, more } = cursor;
  if (first && !more)
    return `All ${shown} ${scope}.`;
  if (first)
    return `${shown} ${scope}; more after this page.`;
  return `${shown} ${scope}; more before this page${more ? ", more after it" : ""}.`;
}
function drawnSentence(shown, scope, { more, draw, of }) {
  return `${shown} ${scope} from a draw of the ${draw} ${of}; ${more ? "more not shown" : "past the draw not reported"}.`;
}
export {
  HANDOFF_LABEL,
  WAYS_IN,
  WAY_IN_BOUND,
  WAY_IN_ORDER,
  drawnSentence,
  nextSection,
  omissionSentence,
  uncountedSentence
};
