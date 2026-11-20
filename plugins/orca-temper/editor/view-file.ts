// The view file's format, one home for both sides: the worker writes it, the custom editor reads
// it. A view file is `<ref>.temper.md` under `.temper-views/` in the focused workspace: the
// record's meta as frontmatter — every value JSON-encoded, which YAML also reads — then the
// body exactly as temper served it. The frontmatter says which record this is and when its base
// was read; the held base itself (the body token the later Save guards on) lives in the plugin's
// storage, never in the file, so nothing an editor or an agent writes here can move it.

/** The folder view files live in, inside the workspace, kept out of git by an exclude entry. */
export const VIEW_DIR = '.temper-views'

/** The suffix the plugin's custom editor opens by default. */
export const VIEW_SUFFIX = '.temper.md'

/** A frontmatter value: the scalars meta carries. */
export type ViewValue = string | number | boolean | null

/** What the view says about its record, in the order the frontmatter writes it. */
export interface ViewHeader {
  id: string
  ref: string
  title: string
  docType: string
  /** When the base was read, ISO-8601 UTC: the tab states it. */
  readAt: string
  /** The record's managed meta, as the read answered it. */
  meta: Record<string, ViewValue>
}

export interface ParsedView {
  header: ViewHeader
  body: string
}

const FENCE = '---'

/**
 * The file name for a record: its decorated ref (title slug plus id), so two records never share
 * a view file, reduced to the characters every file system takes.
 */
export function viewFileName(ref: string): string {
  const safe = ref
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (safe === '') {
    throw new Error('a record ref with no usable characters cannot name a view file')
  }
  return `${safe}${VIEW_SUFFIX}`
}

/** The frontmatter, then the body as served. */
export function composeViewFile(header: ViewHeader, body: string): string {
  const lines = [
    FENCE,
    `id: ${JSON.stringify(header.id)}`,
    `ref: ${JSON.stringify(header.ref)}`,
    `title: ${JSON.stringify(header.title)}`,
    `doc_type: ${JSON.stringify(header.docType)}`,
    `base_read_at: ${JSON.stringify(header.readAt)}`,
    ...Object.entries(header.meta).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    FENCE
  ]
  return `${lines.join('\n')}\n${body}`
}

const FIXED_KEYS = new Set(['id', 'ref', 'title', 'doc_type', 'base_read_at'])

/**
 * Reads a view file back: null when it does not open with the frontmatter this plugin writes,
 * or a fixed key is missing or not a string — a file that does not say which record and which
 * read it is never presents itself as one.
 */
export function parseViewFile(text: string): ParsedView | null {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith(`${FENCE}\n`)) {
    return null
  }
  const end = normalized.indexOf(`\n${FENCE}\n`, FENCE.length)
  if (end === -1) {
    return null
  }
  const fields: Record<string, ViewValue> = {}
  for (const line of normalized.slice(FENCE.length + 1, end).split('\n')) {
    const colon = line.indexOf(': ')
    if (colon <= 0) {
      return null
    }
    try {
      fields[line.slice(0, colon)] = JSON.parse(line.slice(colon + 2)) as ViewValue
    } catch {
      return null
    }
  }
  const text_ = (key: string): string | null => {
    const value = fields[key]
    return typeof value === 'string' ? value : null
  }
  const id = text_('id')
  const ref = text_('ref')
  const title = text_('title')
  const docType = text_('doc_type')
  const readAt = text_('base_read_at')
  if (id === null || ref === null || title === null || docType === null || readAt === null) {
    return null
  }
  const meta = Object.fromEntries(Object.entries(fields).filter(([key]) => !FIXED_KEYS.has(key)))
  return {
    header: { id, ref, title, docType, readAt, meta },
    body: normalized.slice(end + FENCE.length + 2)
  }
}
