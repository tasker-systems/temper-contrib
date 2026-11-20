// Open body: one press from a record's detail puts its body in an Orca editor tab, beside the
// person's view. The worker, in order:
//
//   1. finds the focused workspace (`workspace.readContext`) and its folder (`workspace.list`):
//      none focused, one on another host, or a folder without git refuses, naming why;
//   2. refuses when anything under `.temper-views/` is tracked — a view never enters the
//      repository;
//   3. reads the record with its body and `body_token` (bare UUID, `sections=body`) on the
//      person's grant; a body that is not stored verbatim, or a read with no token, refuses
//      with the way out to temper — nothing it cannot represent faithfully is opened;
//   4. makes sure `.temper-views/` is in the repository's `info/exclude` — the COMMON git dir,
//      so one entry covers every linked worktree — adding it once, never to a tracked file;
//   5. writes `.temper-views/<ref>.temper.md` (meta as frontmatter, the body below), unless a
//      view already there carries changes its held base does not, which it never overwrites;
//   6. holds the base `{id, body_token, base, read_at, path}` in plugin storage;
//   7. calls `editor.open` for that file in that workspace — never `workspace.open`, never
//      anything that moves the person's view.
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { createTemperClient } from '../../vendor/temper-ts.mjs'
import {
  composeViewFile,
  parseViewFile,
  VIEW_DIR,
  viewFileName,
  type ViewValue
} from '../../editor/view-file'
import type { RegionFailure } from '../protocol'
import { GrantLostError, type TemperRead } from '../reads'
import { roomDeps } from './deps'
import {
  heldBaseKey,
  type HeldBase,
  type OpenBodyInput,
  type OpenBodyOutput
} from './protocol'

/** The worker's grant gate: mints (or reuses) the token, then runs the read, or refuses. */
export type Gate = <T>(run: (read: TemperRead) => Promise<T>) => Promise<T | RegionFailure>

/** The exclude line the room writes, and the forms of it that already cover the folder. */
export const EXCLUDE_LINE = `${VIEW_DIR}/`
const COVERING_LINES = new Set([VIEW_DIR, `${VIEW_DIR}/`, `/${VIEW_DIR}`, `/${VIEW_DIR}/`])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message)
}

/** The focused workspace, as `workspace.list` names its folder. */
interface Workspace {
  id: string
  name: string
  path: string
}

async function focusedWorkspace(orca: OrcaWorkerApi): Promise<Workspace> {
  const context = await orca.host.call('workspace.readContext')
  const workspaceId = context?.workspaceId
  if (!context || !workspaceId) {
    refuse('No workspace is focused in Orca — open the workspace the record belongs with, then press Open body again.')
  }
  const { workspaces } = await orca.host.call('workspace.list')
  const row = workspaces.find((entry) => entry.id === workspaceId)
  if (!row) {
    refuse(`Orca does not list the focused workspace (${context.displayName}), so its folder is unknown and nothing was written.`)
  }
  if (row.hostId !== null && row.hostId !== 'local') {
    refuse(`${row.name} is on another host (${row.hostId}); view files are written on this machine only, so nothing was opened.`)
  }
  return { id: row.id, name: row.name, path: row.path }
}

/**
 * The repository's common git dir — where `info/exclude` lives for the main worktree and every
 * linked one. A folder without git refuses: a view written there could not be kept out of a
 * repository the folder may later become.
 */
async function commonGitDir(workspace: Workspace): Promise<string> {
  const answer = await roomDeps.git(['rev-parse', '--git-common-dir'], workspace.path)
  const dir = answer.stdout.trim()
  if (answer.code !== 0 || dir === '') {
    refuse(`${workspace.name} is a folder without git, so a view file there could not be kept out of a repository — nothing was written. Open a git workspace, or open the record in temper.`)
  }
  return isAbsolute(dir) ? dir : resolve(workspace.path, dir)
}

async function refuseTrackedViews(workspace: Workspace): Promise<void> {
  const answer = await roomDeps.git(['ls-files', '--', VIEW_DIR], workspace.path)
  if (answer.code !== 0) {
    throw new Error(`git could not list ${VIEW_DIR}/ in ${workspace.name}: ${answer.stderr.trim()}`)
  }
  if (answer.stdout.trim() !== '') {
    refuse(`${VIEW_DIR}/ holds files the repository tracks in ${workspace.name}; a view file is never written where it would become one of them.`)
  }
}

/**
 * Adds `.temper-views/` to `<common git dir>/info/exclude` unless a line there already covers
 * it. Answers whether it wrote. The exclude file is git's own, never a tracked file.
 */
export async function ensureExcluded(commonDir: string): Promise<boolean> {
  const info = join(commonDir, 'info')
  const exclude = join(info, 'exclude')
  let current = ''
  try {
    current = await readFile(exclude, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  if (current.split(/\r?\n/).some((line) => COVERING_LINES.has(line.trim()))) {
    return false
  }
  await mkdir(info, { recursive: true })
  const separator = current === '' || current.endsWith('\n') ? '' : '\n'
  await appendFile(exclude, `${separator}${EXCLUDE_LINE}\n`, 'utf8')
  return true
}

/** One record read with its body: what the view and the held base are made of. */
interface BodyRead {
  ref: string
  title: string
  docType: string
  body: string
  bodyToken: string
  meta: Record<string, ViewValue>
}

const WAY_OUT = 'Open it in temper instead (Open in temper, on this detail).'

function metaValue(value: unknown): ViewValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return JSON.stringify(value)
}

async function readBody(read: TemperRead, id: string): Promise<BodyRead> {
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
    throw new Error(`temper refused the body read: ${JSON.stringify(error)}`)
  }
  // Ruled 2026-11-20: a body is opened when temper stores it verbatim, at any block count — the
  // guarded save replaces the whole body under one token. A derived body reads back as a
  // reconstruction no byte identity describes, so it is not opened at all.
  if (data.body_storage !== 'verbatim') {
    refuse(`This record's body is not stored verbatim in temper (it reads back as a reconstruction), so it is not opened here — nothing was written. ${WAY_OUT}`)
  }
  if (typeof data.body_token !== 'string' || data.body_token === '') {
    refuse(`temper answered no body token for this record, so no base could be held and nothing was opened. ${WAY_OUT}`)
  }
  const meta = Object.fromEntries(
    Object.entries((data.managed_meta ?? {}) as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, metaValue(value)])
  )
  return {
    ref: data.ref,
    title: data.title,
    docType: data.doc_type_name,
    body: data.content ?? '',
    bodyToken: data.body_token,
    meta
  }
}

/**
 * A view already on disk is replaced only when it still says exactly what its held base said:
 * otherwise someone — the person, an agent — changed it, and those changes are not overwritten.
 */
async function refuseChangedView(orca: OrcaWorkerApi, id: string, path: string): Promise<void> {
  let existing: string
  try {
    existing = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  const held = (await orca.storage.get(heldBaseKey(id))) as HeldBase | null
  const parsed = parseViewFile(existing)
  if (held === null || parsed === null || parsed.body !== held.base) {
    refuse(`The view file for this record already holds changes its base does not (${path}); it is left as it is and nothing was opened over it.`)
  }
}

async function openBody(orca: OrcaWorkerApi, gate: Gate, input: OpenBodyInput): Promise<OpenBodyOutput> {
  if (!UUID.test(input.id)) {
    return { state: 'failed', message: `a bare UUID names a record — "${input.id}" is not one, so nothing is read` }
  }
  try {
    const workspace = await focusedWorkspace(orca)
    const commonDir = await commonGitDir(workspace)
    await refuseTrackedViews(workspace)

    // The gate maps any throw to `failed`, so a refusal the read reaches is carried out as a value.
    const answered = await gate(async (read) => {
      try {
        return { state: 'read' as const, record: await readBody(read, input.id) }
      } catch (error) {
        if (error instanceof Refusal) {
          return { state: 'refused' as const, message: error.message }
        }
        throw error
      }
    })
    if (answered.state !== 'read') {
      return answered
    }
    const record = answered.record

    // Forward slashes: the workspace-relative form Orca's editor.open takes on every platform.
    const relative = `${VIEW_DIR}/${viewFileName(record.ref)}`
    const path = join(workspace.path, relative)
    await refuseChangedView(orca, input.id, path)

    await ensureExcluded(commonDir)
    const readAt = roomDeps.now().toISOString()
    await mkdir(join(workspace.path, VIEW_DIR), { recursive: true })
    await writeFile(
      path,
      composeViewFile(
        { id: input.id, ref: record.ref, title: record.title, docType: record.docType, readAt, meta: record.meta },
        record.body
      ),
      'utf8'
    )
    const held: HeldBase = {
      id: input.id,
      body_token: record.bodyToken,
      base: record.body,
      read_at: readAt,
      path,
      workspaceId: workspace.id
    }
    await orca.storage.set(heldBaseKey(input.id), { ...held })
    // `editor.open` takes the path relative to the workspace (Orca refuses an absolute one).
    await orca.host.call('editor.open', { workspaceId: workspace.id, path: relative })
    return { state: 'opened', path: relative, workspace: workspace.name, readAt }
  } catch (error) {
    if (error instanceof Refusal) {
      return { state: 'refused', message: error.message }
    }
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/** Registers the editor room's requests on the worker. */
export function registerEditorRoom(orca: OrcaWorkerApi, gate: Gate): void {
  orca.panels.handle('temper.body.open', (input: OpenBodyInput) => openBody(orca, gate, input))
}
