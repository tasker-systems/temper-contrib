// The plugin's three reads, asked of the temper API through temper-ts on the credentials the
// caller vetted. An explicit limit rides every list call — the raw list endpoint is uncapped
// without one — and a bogus stage silently matches zero rows, so the stage is named exactly.
// A list orients; only the latest handoff needs the body, and it asks for it explicitly.
import { createTemperClient, type Credentials } from '../vendor/temper-ts.mjs'
import type { FetchLike } from './deps'
import type { HandoffSummary, ResourceSummary } from './protocol'

/** Generous but explicit: a list matches `--all` for any context a person actually keeps. */
export const LIST_LIMIT = 1000

/** What every read shares: the origin the CLI is configured for, the vetted grant, the fetch. */
export interface TemperRead {
  apiUrl: string
  credentials: Credentials
  fetch: FetchLike
}

/**
 * The grant was minted and presented, and temper still refused it with a 401 — the same
 * signed-out refusal as a failed mint: no group data answers.
 */
export class GrantLostError extends Error {
  constructor() {
    super('temper refused the borrowed grant (HTTP 401) during the read')
    this.name = 'GrantLostError'
  }
}

/** The body's Next steps extraction is the handoff's own business; its page is one row. */
export const HANDOFF_PAGE_LIMIT = 1

/** One list request in one context ref, answered with what the rows and page state say. */
interface ListQuery {
  doc_type_name: string
  status?: string
  stage?: string
  sort?: 'updated'
  order?: 'desc'
  limit: number
}

interface ListPage {
  rows: { id: string; ref: string; title: string; updated: string }[]
  truncated: boolean
}

async function listResources(read: TemperRead, contextRef: string, query: ListQuery): Promise<ListPage> {
  const client = createTemperClient({
    baseUrl: read.apiUrl,
    credentials: read.credentials,
    fetch: read.fetch
  })
  const { data, error, response } = await client.GET('/api/resources', {
    params: {
      query: {
        doc_type_name: query.doc_type_name,
        status: query.status,
        stage: query.stage,
        sort: query.sort,
        order: query.order,
        context_ref: contextRef,
        limit: query.limit
      }
    }
  })
  if (error || !data) {
    if (response.status === 401) {
      throw new GrantLostError()
    }
    throw new Error(`temper refused the ${query.doc_type_name} list in ${contextRef}: ${JSON.stringify(error)}`)
  }
  return {
    rows: data.rows.map((row) => ({ id: row.id, ref: row.ref, title: row.title, updated: row.updated })),
    truncated: data.truncated
  }
}

async function listAcrossContexts(
  read: TemperRead,
  contexts: string[],
  query: ListQuery
): Promise<{ resources: ResourceSummary[]; truncated: boolean }> {
  // One request per context ref; the endpoint filters on a single context, so a list of them is
  // one read held over several requests — merged, never partial: a refused context refuses all.
  const pages = await Promise.all(contexts.map((contextRef) => listResources(read, contextRef, query)))
  return {
    resources: pages.flatMap((page) => page.rows.map(({ id, ref, title }) => ({ id, ref, title }))),
    truncated: pages.some((page) => page.truncated)
  }
}

/** The active goals in the goals contexts. */
export async function activeGoals(
  read: TemperRead,
  contexts: string[]
): Promise<{ goals: ResourceSummary[]; truncated: boolean }> {
  const { resources, truncated } = await listAcrossContexts(read, contexts, {
    doc_type_name: 'goal',
    status: 'active',
    limit: LIST_LIMIT
  })
  return { goals: resources, truncated }
}

/** Tasks whose stage is `in-progress` in the work contexts. */
export async function inProgressTasks(
  read: TemperRead,
  contexts: string[]
): Promise<{ tasks: ResourceSummary[]; truncated: boolean }> {
  const { resources, truncated } = await listAcrossContexts(read, contexts, {
    doc_type_name: 'task',
    stage: 'in-progress',
    limit: LIST_LIMIT
  })
  return { tasks: resources, truncated }
}

/** The Next steps section of a session note's markdown body, or null when it carries none. */
export function nextStepsSection(body: string): string | null {
  const lines = body.split('\n')
  const heading = lines.findIndex((line) => /^#{1,6}\s+next steps\s*$/i.test(line.trim()))
  if (heading === -1) {
    return null
  }
  const section: string[] = []
  for (const line of lines.slice(heading + 1)) {
    // The section runs to the next heading of any level, exactly as a reader of the note sees it.
    if (/^#{1,6}\s+\S/.test(line)) {
      break
    }
    section.push(line)
  }
  const text = section.join('\n').trim()
  return text === '' ? null : text
}

/**
 * The latest handoff: the most recently updated session note across the work contexts, read
 * with its body (the list cannot carry one), its Next steps extracted for the panel.
 */
export async function latestHandoff(
  read: TemperRead,
  contexts: string[]
): Promise<{ handoff: HandoffSummary | null; truncated: boolean }> {
  // One one-row page per context — a single context's whole point is "newest here" — then the
  // newest of those wins. Older notes behind the page are the truncation the panel mentions.
  const pages = await Promise.all(
    contexts.map(async (contextRef) => ({
      contextRef,
      page: await listResources(read, contextRef, {
        doc_type_name: 'session',
        sort: 'updated',
        order: 'desc',
        limit: HANDOFF_PAGE_LIMIT
      })
    }))
  )
  const notes = pages.flatMap(({ contextRef, page }) =>
    page.rows.map((row) => ({ ...row, contextRef }))
  )
  const truncated = pages.some(({ page }) => page.truncated)
  const newest = notes.reduce<typeof notes[number] | null>((best, note) => {
    if (best === null || note.updated > best.updated) {
      return note
    }
    return best
  }, null)
  if (newest === null) {
    return { handoff: null, truncated }
  }

  const client = createTemperClient({
    baseUrl: read.apiUrl,
    credentials: read.credentials,
    fetch: read.fetch
  })
  const { data, error, response } = await client.GET('/api/resources/{id}', {
    params: { path: { id: newest.id }, query: { sections: 'body' } }
  })
  if (error || !data) {
    if (response.status === 401) {
      throw new GrantLostError()
    }
    throw new Error(`temper refused the handoff body read: ${JSON.stringify(error)}`)
  }
  const { id, ref, title } = newest
  return {
    handoff: {
      id,
      ref,
      title,
      contextRef: newest.contextRef,
      nextSteps: nextStepsSection(data.content ?? '')
    },
    truncated
  }
}
