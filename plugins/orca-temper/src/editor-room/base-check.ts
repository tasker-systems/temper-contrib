// Whether temper has moved past a held base: the custom editor asks on open, when the tab is
// focused and once a minute, and states the answer in its header. The worker reads the record's
// current `body_token` on the person's grant — the same single-record body read Open body made,
// because only that read answers a token — and compares it with the token held when the base
// was read. It writes nothing, in temper or on disk.
import type { OrcaWorkerApi } from 'orca/worker'
import { createTemperClient } from '../../vendor/temper-ts.mjs'
import { GrantLostError, type TemperRead } from '../reads'
import { roomDeps } from './deps'
import type { Gate } from './open-body'
import { heldBaseKey, type BaseCheckInput, type BaseCheckOutput, type HeldBase } from './protocol'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const NO_BASE_MESSAGE =
  'No base is held for this record here, so whether temper has moved past it is not known. Open it again from the Temper rail.'

/** temper's current body token for a record, and when it says the record last changed. */
async function currentToken(read: TemperRead, id: string): Promise<{ token: string | null; updated: string | null }> {
  const client = createTemperClient({
    baseUrl: read.apiUrl,
    credentials: read.credentials,
    fetch: read.fetch
  })
  const { data, error, response } = await client.GET('/api/resources/{id}', {
    params: { path: { id }, query: { sections: 'body' } }
  })
  if (error || !data) {
    if (response.status === 401) {
      throw new GrantLostError()
    }
    throw new Error(`temper refused the base check: ${JSON.stringify(error)}`)
  }
  return {
    token: typeof data.body_token === 'string' && data.body_token !== '' ? data.body_token : null,
    updated: typeof data.updated === 'string' ? data.updated : null
  }
}

async function checkBase(orca: OrcaWorkerApi, gate: Gate, input: BaseCheckInput): Promise<BaseCheckOutput> {
  if (!UUID.test(input.id)) {
    return { state: 'failed', message: `a bare UUID names a record — "${input.id}" is not one, so nothing is read` }
  }
  const held = (await orca.storage.get(heldBaseKey(input.id))) as HeldBase | null
  if (held === null || typeof held.body_token !== 'string') {
    return { state: 'no-base', message: NO_BASE_MESSAGE }
  }
  return gate(async (read) => {
    const current = await currentToken(read, input.id)
    const checkedAt = roomDeps.now().toISOString()
    // A read with no token cannot show the base is current, so it never says so.
    if (current.token === null) {
      throw new Error('temper answered no body token, so whether it has moved past the base is not known')
    }
    return current.token === held.body_token
      ? { state: 'current' as const, readAt: held.read_at, checkedAt }
      : { state: 'behind' as const, readAt: held.read_at, checkedAt, updatedAt: current.updated }
  })
}

/** Registers `temper.body.base` on the worker. */
export function registerBaseCheck(orca: OrcaWorkerApi, gate: Gate): void {
  orca.panels.handle('temper.body.base', (input: BaseCheckInput) => checkBase(orca, gate, input))
}
