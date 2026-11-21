// Save: the one act by which a body reaches temper from the editor room. Editing, a local file
// save, closing or reopening the tab write nothing to temper; only the view's Save does, and only
// through `temper resource update <id> --body @<file> --expect-body <held token>`, run by this
// worker as the person acting through the plugin's UI (a fixed persona, a confidence band, no
// model). The frontmatter is the view's own: only the body is sent.
//
//   - No held token: refused before the CLI runs — temper never receives a save that names no
//     expected version.
//   - Accepted: the held base becomes the saved version (its new token, the save's time).
//   - Refused as stale (`PRECONDITION_FAILED` on the body): nothing was written. One read of
//     temper's current answers the three versions, and that current is held for carry-over.
//
// Also here: the local-save check (reads the view file only, never temper) and carry-over /
// discard after a refused save (moves the held base onto the current; writes nothing to temper).
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { composeViewFile, parseViewFile } from '../../editor/view-file'
import { deps } from '../deps'
import { GrantLostError } from '../reads'
import { readCurrent } from './base-check'
import { roomDeps } from './deps'
import type { Gate } from './open-body'
import {
  heldBaseKey,
  heldCurrentKey,
  type HeldBase,
  type HeldCurrent,
  type LocalSaveInput,
  type LocalSaveOutput,
  type RebaseInput,
  type RebaseOutput,
  type SaveInput,
  type SaveOutput
} from './protocol'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The persona a pressed Save is authored as: the person, acting through this plugin's UI. */
export const SAVE_PERSONA = 'orca-temper-ui'
/** The band the CLI requires beside a persona: the person pressed Save on the text in view. */
export const SAVE_CONFIDENCE = 'confident'

export const NO_BASE_SAVE_MESSAGE =
  'No base is held for this record here, so a save could not say which version it replaces — nothing was sent to temper. Open it again from the Temper rail.'

/** The CLI's arguments for one guarded body save; never a `--model`: the person pressed it. */
export function saveArgs(id: string, bodyFile: string, token: string): string[] {
  return [
    'resource',
    'update',
    id,
    '--body',
    `@${bodyFile}`,
    '--expect-body',
    token,
    '--persona',
    SAVE_PERSONA,
    '--confidence',
    SAVE_CONFIDENCE,
    '--format',
    'json'
  ]
}

async function heldBase(orca: OrcaWorkerApi, id: string): Promise<HeldBase | null> {
  const held = (await orca.storage.get(heldBaseKey(id))) as HeldBase | null
  return held !== null && typeof held.body_token === 'string' && held.body_token !== '' ? held : null
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Whether the CLI's refusal is the body guard's: temper had moved past the held token. */
function staleBody(answer: Record<string, unknown> | null): boolean {
  if (answer?.['code'] !== 'PRECONDITION_FAILED') return false
  const details = answer['details'] as { failed?: unknown } | undefined
  const failed = Array.isArray(details?.failed) ? details.failed : []
  return failed.some((entry) => (entry as { tier?: unknown } | null)?.tier === 'body')
}

async function save(orca: OrcaWorkerApi, gate: Gate, input: SaveInput): Promise<SaveOutput> {
  if (!UUID.test(input.id)) {
    return { state: 'failed', message: `a bare UUID names a record — "${input.id}" is not one, so nothing is sent` }
  }
  const held = await heldBase(orca, input.id)
  if (held === null) {
    return { state: 'no-base', message: NO_BASE_SAVE_MESSAGE }
  }
  const view = typeof input.text === 'string' ? parseViewFile(input.text) : null
  if (view === null || view.header.id !== input.id) {
    return {
      state: 'refused',
      message: 'The view does not say it is this record, so nothing was sent to temper. Open it again from the Temper rail.'
    }
  }
  return gate(async (read) => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-temper-save-'))
    try {
      const bodyFile = join(dir, 'body.md')
      await writeFile(bodyFile, view.body, 'utf8')
      const result = await deps.run(saveArgs(input.id, bodyFile, held.body_token), process.env)
      const answer = parseJson(result.stdout)
      if (result.code === 0) {
        const token = answer?.['body_token']
        if (typeof token !== 'string' || token === '') {
          throw new Error('temper took the save but answered no body token, so the new base is not known — open the record again from the Temper rail')
        }
        const readAt = roomDeps.now().toISOString()
        const saved: HeldBase = { ...held, body_token: token, base: view.body, read_at: readAt }
        await orca.storage.set(heldBaseKey(input.id), { ...saved })
        await orca.storage.delete(heldCurrentKey(input.id))
        const updated = answer?.['updated']
        return { state: 'saved' as const, readAt, updatedAt: typeof updated === 'string' ? updated : null }
      }
      if (staleBody(answer)) {
        // Nothing was written. One read of temper's current makes the third version.
        const current = await readCurrent(read, input.id)
        if (current.token === null) {
          throw new Error('temper refused the save as stale, then answered no body token for its current version')
        }
        const currentReadAt = roomDeps.now().toISOString()
        const kept: HeldCurrent = { id: input.id, body_token: current.token, current: current.content, read_at: currentReadAt }
        await orca.storage.set(heldCurrentKey(input.id), { ...kept })
        return {
          state: 'stale' as const,
          base: held.base,
          mine: view.body,
          current: current.content,
          currentReadAt,
          updatedAt: current.updated
        }
      }
      const code = typeof answer?.['code'] === 'string' ? answer['code'] : null
      if (code === 'NOT_AUTHENTICATED' || code === 'UNAUTHORIZED') {
        throw new GrantLostError()
      }
      const words =
        (typeof answer?.['message'] === 'string' ? answer['message'] : '') ||
        result.stderr.trim().split('\n')[0] ||
        `exit ${result.code}`
      throw new Error(`temper refused the save, and nothing was written: ${words}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

/** Whether the view file on disk holds a body the held base does not — a local save. */
async function localSave(orca: OrcaWorkerApi, input: LocalSaveInput): Promise<LocalSaveOutput> {
  if (!UUID.test(input.id)) {
    return { state: 'unknown', message: `a bare UUID names a record — "${input.id}" is not one` }
  }
  const held = (await orca.storage.get(heldBaseKey(input.id))) as HeldBase | null
  if (held === null) {
    return { state: 'no-base', message: NO_BASE_SAVE_MESSAGE }
  }
  try {
    const [text, info] = await Promise.all([readFile(held.path, 'utf8'), stat(held.path)])
    const view = parseViewFile(text)
    if (view !== null && view.body === held.base) {
      return { state: 'clean' }
    }
    return { state: 'saved-locally', savedAt: info.mtime.toISOString() }
  } catch (error) {
    return {
      state: 'unknown',
      message: `the view file could not be read (${error instanceof Error ? error.message : String(error)})`
    }
  }
}

/** After a refused save: the current version becomes the held base. Writes nothing to temper. */
async function rebase(orca: OrcaWorkerApi, input: RebaseInput): Promise<RebaseOutput> {
  if (!UUID.test(input.id)) {
    return { state: 'failed', message: `a bare UUID names a record — "${input.id}" is not one` }
  }
  const held = await heldBase(orca, input.id)
  const current = (await orca.storage.get(heldCurrentKey(input.id))) as HeldCurrent | null
  if (held === null || current === null || typeof current.body_token !== 'string') {
    return {
      state: 'refused',
      message: 'No refused save is held for this record, so there is no current version to move onto. Press Save again.'
    }
  }
  try {
    if (input.discard) {
      // The person's text is dropped: the view file says the current version, from its base.
      const view = parseViewFile(await readFile(held.path, 'utf8'))
      if (view === null) {
        return { state: 'refused', message: 'The view file no longer says which record it is, so it was not rewritten.' }
      }
      await writeFile(held.path, composeViewFile({ ...view.header, readAt: current.read_at }, current.current), 'utf8')
    }
    const moved: HeldBase = { ...held, body_token: current.body_token, base: current.current, read_at: current.read_at }
    await orca.storage.set(heldBaseKey(input.id), { ...moved })
    await orca.storage.delete(heldCurrentKey(input.id))
    return { state: 'rebased', readAt: current.read_at, discarded: input.discard === true }
  } catch (error) {
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/** Registers `temper.body.save`, `temper.body.local` and `temper.body.rebase` on the worker. */
export function registerSave(orca: OrcaWorkerApi, gate: Gate): void {
  orca.panels.handle('temper.body.save', (input: SaveInput) => save(orca, gate, input))
  orca.panels.handle('temper.body.local', (input: LocalSaveInput) => localSave(orca, input))
  orca.panels.handle('temper.body.rebase', (input: RebaseInput) => rebase(orca, input))
}
