// The plugin's reads, asked of the temper API through temper-ts on the credentials the caller
// vetted — the person-scoped reads temper-ui's home makes (design record, Rulings Q1/R2), never
// context-scoped ones. An explicit limit rides every list call — the raw list endpoint is
// uncapped without one — and the ways-in filters come from temper-design's WAYS_IN, so the rail
// asks for each way under the same name, scope and filter as both other surfaces. A list
// orients; only the latest handoff needs a body, and it asks for it explicitly, the Next section
// quoted by temper-design's own parser.
import { createTemperClient, type Credentials } from '../vendor/temper-ts.mjs'
import { WAYS_IN, nextSection } from '../vendor/temper-design.mjs'
import type { FetchLike } from './deps'
import type {
  NextSummary,
  PlaceInUse,
  ResourceSummary
} from './protocol'

/** What every read shares: the origin temper auth status reports, the vetted grant, the fetch. */
export interface TemperRead {
  apiUrl: string
  credentials: Credentials
  fetch: FetchLike
}

/**
 * The grant was minted and presented, and temper still refused it with a 401 — the same
 * signed-out refusal as a failed mint: no region data answers.
 */
export class GrantLostError extends Error {
  constructor() {
    super('temper refused the borrowed grant (HTTP 401) during the read')
    this.name = 'GrantLostError'
  }
}

/** Resume is one row: the person changed exactly this most recently, or nothing. */
export const RESUME_PAGE_LIMIT = 1

/** The handoff's page is one row — the newest session — then its body. */
export const HANDOFF_PAGE_LIMIT = 1

/** How many places and recently-updated rows Home shows — temper-ui's bound for the same lists. */
export const HOME_LIST_BOUND = 5

type Client = ReturnType<typeof createTemperClient>

function clientOf(read: TemperRead): Client {
  return createTemperClient({
    baseUrl: read.apiUrl,
    credentials: read.credentials,
    fetch: read.fetch
  })
}

/** One row of the list door, as Home carries it. */
interface ListRow {
  id: string
  ref: string
  title: string
  doc_type_name: string
  context_ref?: string | null
  updated: string
  changed_by_me_at?: string | null
}

interface ListPage {
  rows: ListRow[]
  total: number
}

function summaryOf(row: ListRow): ResourceSummary {
  return {
    id: row.id,
    ref: row.ref,
    title: row.title,
    docType: row.doc_type_name,
    contextRef: row.context_ref ?? null,
    updated: row.updated
  }
}

/** The query every Home list asks, each part named by its caller. */
interface ListQuery {
  doc_type_name?: string
  owner?: string
  changed_by?: string
  status?: string
  stage?: string
  sort?: 'updated' | 'changed_by_me'
  order?: 'desc'
  limit: number
}

/** One list request, answered with the rows and the total the page stands before. */
async function listResources(read: TemperRead, what: string, query: ListQuery): Promise<ListPage> {
  const client = clientOf(read)
  const { data, error, response } = await client.GET('/api/resources', {
    params: {
      query: {
        doc_type_name: query.doc_type_name,
        owner: query.owner,
        changed_by: query.changed_by,
        status: query.status,
        stage: query.stage,
        sort: query.sort,
        order: query.order,
        limit: query.limit
      }
    }
  })
  if (error || !data) {
    if (response.status === 401) {
      throw new GrantLostError()
    }
    throw new Error(`temper refused the ${what} read: ${JSON.stringify(error)}`)
  }
  return { rows: data.rows, total: data.total }
}

/**
 * Resume: the one resource the person most recently changed, by their own change time — the
 * order the list door gives `sort=changed_by_me`, which it accepts only under `changed_by=@me`.
 * A row without its change time is a broken read (never `updated` in its place), so it fails
 * the region rather than claiming a recency the person may not hold.
 */
export async function resumeItem(
  read: TemperRead
): Promise<{ resume: { resource: ResourceSummary; changedAt: string } | null }> {
  const page = await listResources(read, 'resume', {
    changed_by: '@me',
    sort: 'changed_by_me',
    order: 'desc',
    limit: RESUME_PAGE_LIMIT
  })
  const row = page.rows[0]
  if (!row) {
    return { resume: null }
  }
  if (row.changed_by_me_at == null) {
    throw new Error('the time of your change was not returned')
  }
  return { resume: { resource: summaryOf(row), changedAt: row.changed_by_me_at } }
}

/**
 * The latest handoff: the person's most recently updated session, read with its body (the list
 * cannot carry one), its Next section quoted by temper-design's own `nextSection` — as written,
 * bounded, and null when the session names no Next heading.
 */
export async function latestHandoff(
  read: TemperRead
): Promise<{
  handoff: { id: string; ref: string; title: string; next: NextSummary | null } | null
  sessionCount: number
}> {
  const page = await listResources(read, 'latest handoff', {
    doc_type_name: 'session',
    owner: '@me',
    sort: 'updated',
    order: 'desc',
    limit: HANDOFF_PAGE_LIMIT
  })
  const row = page.rows[0]
  if (!row) {
    return { handoff: null, sessionCount: page.total }
  }

  const client = clientOf(read)
  const { data, error, response } = await client.GET('/api/resources/{id}', {
    params: { path: { id: row.id }, query: { sections: 'body' } }
  })
  if (error || !data) {
    if (response.status === 401) {
      throw new GrantLostError()
    }
    throw new Error(`temper refused the handoff body read: ${JSON.stringify(error)}`)
  }
  const { id, ref, title } = row
  return {
    handoff: { id, ref, title, next: nextSection(data.content ?? '') },
    sessionCount: page.total
  }
}

/**
 * One of the standing ways in — goals, in progress, sessions — at the bound the panel asks for:
 * the filter is the way's own from WAYS_IN (`owner: '@me'`, the workflow state where one
 * applies), newest update first. An id WAYS_IN does not name is the caller's error, not a read.
 */
export async function wayIn(
  read: TemperRead,
  id: string,
  bound: number
): Promise<{
  id: string
  label: string
  scope: string
  rows: ResourceSummary[]
  total: number
  bound: number
}> {
  const way = WAYS_IN.find((entry) => entry.id === id)
  if (!way) {
    throw new Error(`unknown way in: ${id}`)
  }
  const page = await listResources(read, way.scope, {
    doc_type_name: way.filter.docType,
    owner: way.filter.owner,
    status: way.filter.status,
    stage: way.filter.stage,
    sort: 'updated',
    order: 'desc',
    limit: bound
  })
  return {
    id: way.id,
    label: way.label,
    scope: way.scope,
    rows: page.rows.map(summaryOf),
    total: page.total,
    bound
  }
}

/**
 * The places the person works in: the contexts they changed something in, newest change of their
 * own first. The activity read carries no names, so each place takes its name and ref from the
 * contexts read; a place missing from it is dropped — a race between the two reads, and an
 * unnamed row could not be followed. A contexts read that failed fails the region instead.
 */
export async function placesInUse(
  read: TemperRead
): Promise<{ rows: PlaceInUse[]; total: number }> {
  const client = clientOf(read)
  const [activityAnswer, contextsAnswer] = await Promise.all([
    client.GET('/api/me/context-activity'),
    client.GET('/api/contexts')
  ])
  // The spec declares only the 200 for these two reads, so the failure shows through `data`:
  // narrow on it (keying on `error`, typed never, collapses the branch's type).
  if (!activityAnswer.data) {
    if (activityAnswer.response.status === 401) {
      throw new GrantLostError()
    }
    throw new Error(`temper refused the places read: HTTP ${activityAnswer.response.status}`)
  }
  if (!contextsAnswer.data) {
    if (contextsAnswer.response.status === 401) {
      throw new GrantLostError()
    }
    throw new Error(`temper refused the contexts read: HTTP ${contextsAnswer.response.status}`)
  }
  const activity = activityAnswer.data
  const contexts = contextsAnswer.data
  const refById = new Map(
    contexts.map((context) => [
      context.id,
      { ref: `${context.owner_ref}/${context.slug}`, name: context.name }
    ])
  )
  const all = activity.flatMap(({ context_id, last_changed_at }) => {
    const place = refById.get(context_id)
    return place ? [{ ...place, lastChangedAt: last_changed_at }] : []
  })
  all.sort((a, b) => Date.parse(b.lastChangedAt) - Date.parse(a.lastChangedAt))
  return { rows: all.slice(0, HOME_LIST_BOUND), total: all.length }
}

/** Recently updated, across everything the person can read — the list door's default scope. */
export async function recentlyUpdated(
  read: TemperRead
): Promise<{ rows: ResourceSummary[]; total: number }> {
  const page = await listResources(read, 'recently updated', {
    sort: 'updated',
    order: 'desc',
    limit: HOME_LIST_BOUND
  })
  return { rows: page.rows.map(summaryOf), total: page.total }
}
