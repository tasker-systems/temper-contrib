// The serves marker (decision ruling 27): on each launch for a task, the worker writes
// `.temper-views/serves.json` in the new workspace's folder, so any agent there — a chat agent
// Orca's launch hook never reaches, a terminal agent, another harness, one started outside
// Orca — can learn which task the workspace was started for, and in which context:
//
//   { "task_ref", "task_id", "context_ref", "title", "written_at" }
//
// It is a pointer, never task state (ruling 26): no stage, claim or work in flight. The folder
// is the editor room's: kept out of git by its `info/exclude` entry in the common git dir, which
// the marker write makes sure of first, and refused where anything under it is tracked. A launch
// for a goal or a session writes none, and removes one left there. Nothing here may stop a
// launch (`temper-never-blocks-orca`): every failure is answered as words for the sheet.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { VIEW_DIR } from '../editor/view-file'
import { commonGitDir, ensureExcluded, refuseTrackedViews } from './editor-room/open-body'
import { roomDeps } from './editor-room/deps'
import type { LaunchLink } from './protocol'

export const MARKER_FILE = 'serves.json'

/** The marker's fields, exactly: which task, its context, its title, and when it was written. */
export interface ServesMarker {
  task_ref: string
  task_id: string
  context_ref: string | null
  title: string | null
  written_at: string
}

/** Where a workspace's marker lives. */
export function markerPath(workspacePath: string): string {
  return join(workspacePath, VIEW_DIR, MARKER_FILE)
}

/** The marker one link writes, or null for a link to anything but a task. */
export function markerFor(
  link: Pick<LaunchLink, 'docType' | 'ref' | 'itemId' | 'contextRef' | 'title'>,
  now: Date
): ServesMarker | null {
  if (link.docType !== 'task') {
    return null
  }
  return {
    task_ref: link.ref !== '' ? link.ref : link.itemId,
    task_id: link.itemId,
    context_ref: link.contextRef !== null && link.contextRef !== '' ? link.contextRef : null,
    title: typeof link.title === 'string' && link.title !== '' ? link.title : null,
    written_at: now.toISOString()
  }
}

/**
 * Writes the launch's marker in the workspace folder — or, for a launch that is not a task's,
 * removes a marker left there. Answers null when done, or the words for why not.
 */
export async function placeMarker(
  workspace: { name: string; path: string },
  link: Pick<LaunchLink, 'docType' | 'ref' | 'itemId' | 'contextRef' | 'title'>
): Promise<string | null> {
  const marker = markerFor(link, roomDeps.now())
  const file = markerPath(workspace.path)
  try {
    if (marker === null) {
      await rm(file, { force: true })
      return null
    }
    await refuseTrackedViews(workspace)
    await ensureExcluded(await commonGitDir(workspace))
    await mkdir(join(workspace.path, VIEW_DIR), { recursive: true })
    // Written whole, then renamed into place: a reader never sees half a marker.
    const partial = `${file}.${process.pid}.partial`
    await writeFile(partial, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    await rename(partial, file)
    return null
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return marker === null
      ? `the old serves marker in ${workspace.name} could not be removed: ${reason}`
      : `the serves marker was not written in ${workspace.name}: ${reason}`
  }
}

/** The marker in a workspace folder, or null when there is none or it does not parse as one. */
export async function readMarker(workspacePath: string): Promise<ServesMarker | null> {
  let text: string
  try {
    text = await readFile(markerPath(workspacePath), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const row = parsed as Record<string, unknown>
  if (typeof row['task_ref'] !== 'string' || row['task_ref'] === '' || typeof row['task_id'] !== 'string') {
    return null
  }
  return {
    task_ref: row['task_ref'],
    task_id: row['task_id'],
    context_ref: typeof row['context_ref'] === 'string' && row['context_ref'] !== '' ? row['context_ref'] : null,
    title: typeof row['title'] === 'string' ? row['title'] : null,
    written_at: typeof row['written_at'] === 'string' ? row['written_at'] : ''
  }
}

/** The folder Orca's worktree id (`<project>::<path>`) names, or null for any other id. */
export function pathOfWorktreeId(workspaceId: string): string | null {
  const at = workspaceId.indexOf('::')
  if (at <= 0) {
    return null
  }
  const path = workspaceId.slice(at + 2)
  return isAbsolute(path) ? path : null
}
