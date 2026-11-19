// The plugin's one read: the person's active goals in one context ref, asked of the temper API
// through temper-ts on the credentials the caller vetted. An explicit limit rides every call —
// the raw list endpoint is uncapped without one.
import { createTemperClient, type Credentials } from '../vendor/temper-ts.mjs'
import type { FetchLike } from './deps'
import type { GoalSummary } from './protocol'

/** Generous but explicit: list matches `--all` for any context a person actually keeps. */
const ACTIVE_GOALS_LIMIT = 1000

export interface GoalsSource {
  apiUrl: string
  contextRef: string
  credentials: Credentials
  fetch: FetchLike
}

export async function activeGoals(
  source: GoalsSource
): Promise<{ goals: GoalSummary[]; truncated: boolean }> {
  const client = createTemperClient({
    baseUrl: source.apiUrl,
    credentials: source.credentials,
    fetch: source.fetch
  })
  const { data, error } = await client.GET('/api/resources', {
    params: {
      query: {
        doc_type_name: 'goal',
        status: 'active',
        context_ref: source.contextRef,
        limit: ACTIVE_GOALS_LIMIT
      }
    }
  })
  if (error || !data) {
    throw new Error(`temper refused the goals read: ${JSON.stringify(error)}`)
  }
  return {
    goals: data.rows.map((row) => ({ id: row.id, ref: row.ref, title: row.title })),
    truncated: data.truncated
  }
}
