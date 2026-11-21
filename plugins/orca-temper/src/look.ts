// How the rail's words wear Orca's controls: the doc-type icons, the state words and their
// badge tones, the act icons, and the detail's meta as the rail shows it. Each mark sits beside
// its word and never stands in for it — the doc-type word stays in a row's description, a badge
// holds its word, and a tone adds weight only (accent is Orca's one emphasis, and monochrome).
import type { IconName, KeyValueItem, Tone } from 'orca'
import type { PropertyRow, RecordDetail } from './protocol'

/** The doc-type icon on a row; a doc type not named here takes the plain `file`. */
export const DOC_TYPE_ICON: Readonly<Record<string, IconName>> = {
  goal: 'flag',
  task: 'hammer',
  session: 'agent',
  decision: 'branch',
  research: 'lightbulb',
  concept: 'book',
  spec: 'file-text'
}

/** A place (a context row) is not a doc type; it takes its own glyph. */
export const PLACE_ICON: IconName = 'folder'

export function docTypeIcon(docType: string): IconName {
  return DOC_TYPE_ICON[docType] ?? 'file'
}

/** The icons on the labelled act buttons; the label always carries the act. */
export const ACT_ICON = {
  launch: 'play',
  goalWork: 'rocket',
  openBody: 'file-text',
  openInTemper: 'open-external',
  showMore: 'expand',
  refresh: 'refresh'
} as const satisfies Record<string, IconName>

/** A stage or status in words: `in-progress` reads "in progress". */
export function stateWord(state: string): string {
  return state.replace(/-/g, ' ')
}

/**
 * A detail's stage or status badge tone: accent (the inverted pill) for the state being worked,
 * success for done, neutral for anything else — the word in the badge says which.
 */
export function stateTone(state: string): Tone {
  if (state === 'in-progress' || state === 'active') {
    return 'accent'
  }
  if (state === 'done') {
    return 'success'
  }
  return 'neutral'
}

/** The record's own state: a task's stage, else a goal's status; null when it carries neither. */
export function recordState(detail: Pick<RecordDetail, 'stage' | 'status'>): string | null {
  return detail.stage ?? detail.status
}

/** A list row's description: the doc-type word, then its state in words when it has one. */
export function rowDescription(docType: string, state: string | null | undefined): string {
  return state === null || state === undefined || state === ''
    ? docType
    : `${docType} · ${stateWord(state)}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A timestamp as a person reads it, in UTC so every machine reads the same words:
 * "20 Nov 2026, 01:00 UTC". A value that is not a time is shown as it came.
 */
export function formatTime(value: string): string {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) {
    return value
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
}

/**
 * The detail's meta as the rail shows it: temper-ui's order kept, the `doc_type` row dropped
 * (the header already says it), `updated` formatted, and the ref closing the run in mono.
 */
export function metaItems(detail: Pick<RecordDetail, 'ref' | 'properties'>): KeyValueItem[] {
  const rows: KeyValueItem[] = detail.properties
    .filter((row: PropertyRow) => row.label !== 'doc_type')
    .map((row: PropertyRow) =>
      row.label === 'updated' && typeof row.value === 'string'
        ? { label: row.label, value: formatTime(row.value) }
        : { label: row.label, value: row.value }
    )
  rows.push({ label: 'ref', value: detail.ref, code: true })
  return rows
}
