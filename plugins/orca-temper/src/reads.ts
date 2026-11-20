// The plugin's reads, asked of the temper API through temper-ts on the credentials the caller
// vetted — the person-scoped reads temper-ui's home makes (design record, Rulings Q1/R2), never
// context-scoped ones. An explicit limit rides every list call — the raw list endpoint is
// uncapped without one — and the ways-in filters come from temper-design's WAYS_IN, so the rail
// asks for each way under the same name, scope and filter as both other surfaces. A list
// orients; only the latest handoff needs a body, and it asks for it explicitly, the Next section
// quoted by temper-design's own parser. A record's detail asks for neither — the single-record
// door with no `sections` query answers the meta alone, so the body never crosses the read.
import { createTemperClient, type Credentials } from '../vendor/temper-ts.mjs'
import { WAYS_IN, nextSection } from '../vendor/temper-design.mjs'
import type { FetchLike } from './deps'
import type {
  NextSummary,
  PlaceInUse,
  PropertyRow,
  RecordDetail,
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

/**
 * The linked-tasks bound lives in the panel <-> worker contract (`./protocol`), one home for
 * the bound the panel names and the answer bounds.
 *
 * temper-ui's editorial order for the managed run, from
 * `packages/temper-ui/src/lib/properties.ts`: ranked keys lead in this order, unranked managed
 * keys follow alphabetically. Interim, like `WAY_IN_MAX` above: temper-design does not yet
 * export it, so the rail carries it locally until temper-design publishes it and the follow-up
 * import swaps it for the package's export.
 */
const MANAGED_KEY_ORDER = [
  'temper-stage',
  'temper-mode',
  'temper-effort',
  'temper-status',
  'temper-seq',
  'temper-llm-model',
  'temper-llm-run',
  'temper-provenance',
  'temper-branch',
  'temper-pr'
] as const

const MANAGED_RANK = new Map<string, number>(MANAGED_KEY_ORDER.map((key, index) => [key, index]))

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
  /** The goal filter, task only: the resolved goal id as a bare UUID (the API's own contract). */
  goal?: string
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
        goal: query.goal,
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

/**
 * A bare UUID names a resource on the single-record door — a decorated ref is a client error,
 * not a read. The detail read takes exactly that: the path id without decoration, the query
 * without `sections`, so the read downloads no body to leave out.
 */
function assertBareId(id: string, what: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`a bare UUID names ${what} — "${id}" is not one, so nothing is read`)
  }
}

/**
 * A managed value as the meta row carries it: the scalars as they come, a structured one as its
 * JSON. The closed vocabulary holds scalars, so the fallback is for nothing the register writes
 * today — a value that could never render as itself is shown, not dropped.
 */
function propertyValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return JSON.stringify(value)
}

/**
 * The detail's meta rows, in temper-ui's order (mergeProperties, packages/temper-ui/
 * src/lib/properties.ts): `doc_type` first, then the managed run — ranked keys lead per
 * MANAGED_KEY_ORDER, unranked follow alphabetically. The open run is not read (no `sections`
 * query), so no open row appears. Context, owner and updated close the run — the words the
 * record's card carries — and a cogmap-homed record shows no context row: none is invented.
 */
function detailProperties(resource: {
  doc_type_name: string
  managed_meta: Record<string, unknown> | null | undefined
  context_ref: string | null
  cogmap_name: string | null
  owner_handle: string
  updated: string
}): PropertyRow[] {
  const managed = Object.entries(resource.managed_meta ?? {})
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([label, value]) => ({ label, value: propertyValue(value) }))
  managed.sort((a, b) => {
    const ra = MANAGED_RANK.get(a.label) ?? MANAGED_KEY_ORDER.length
    const rb = MANAGED_RANK.get(b.label) ?? MANAGED_KEY_ORDER.length
    return ra === rb ? a.label.localeCompare(b.label) : ra - rb
  })
  const rows: PropertyRow[] = [{ label: 'doc_type', value: resource.doc_type_name }, ...managed]
  if (resource.context_ref !== null && resource.context_ref !== undefined) {
    rows.push({ label: 'context', value: resource.context_ref })
  }
  if (resource.owner_handle) {
    rows.push({ label: 'owner', value: resource.owner_handle })
  }
  rows.push({ label: 'updated', value: resource.updated })
  return rows
}

/**
 * One record's meta by its bare UUID, asking neither body nor sections: the single-record door
 * answers the managed run and the card fields without downloading a word of the body, so the
 * detail can show the meta and stay out of the body entirely.
 */
export async function resourceDetail(read: TemperRead, id: string): Promise<RecordDetail> {
  assertBareId(id, 'a record')
  const client = clientOf(read)
  const { data, error, response } = await client.GET('/api/resources/{id}', {
    params: { path: { id } }
  })
  if (error || !data) {
    if (response.status === 401) {
      throw new GrantLostError()
    }
    throw new Error(`temper refused the record read: ${JSON.stringify(error)}`)
  }
  return {
    id,
    ref: data.ref,
    title: data.title,
    docType: data.doc_type_name,
    properties: detailProperties({
      doc_type_name: data.doc_type_name,
      managed_meta: data.managed_meta as Record<string, unknown> | null | undefined,
      context_ref: data.context_ref ?? null,
      cogmap_name: data.cogmap_name ?? null,
      owner_handle: data.owner_handle,
      updated: data.updated
    })
  }
}

/**
 * A goal's linked tasks: the tasks joined to it by a live `advances` edge — the edges that were
 * asserted at create, so the list is what linking recorded, never every task of the goal's kind.
 * The ruled query (`Rulings Q4a`) names no order and takes no owner, so none is sent; the limit
 * is the caller's bound, explicit because the raw list endpoint is uncapped without one, and
 * the view's omission sentence stands under it.
 */
export async function goalLinkedTasks(
  read: TemperRead,
  goalId: string,
  bound: number
): Promise<{ rows: ResourceSummary[]; total: number; bound: number }> {
  assertBareId(goalId, 'a goal')
  const page = await listResources(read, 'linked tasks', {
    doc_type_name: 'task',
    goal: goalId,
    limit: bound
  })
  return { rows: page.rows.map(summaryOf), total: page.total, bound }
}
