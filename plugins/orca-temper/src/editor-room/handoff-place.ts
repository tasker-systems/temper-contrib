// Where a refused save's "Hand to an agent" starts its agent (decision ruling 25): a new
// workspace (`workspace.create`) in the same project as the view's workspace, since Orca's
// `agent.launch` drops its prompt (stablyai/orca#41107). The agent works in that new workspace
// but writes its reconciliation into the view file the person has open, so the prompt names the
// file by its absolute path.
//
// `temper.body.handoff-place` answers both from `workspace.list`: the view workspace's project,
// and the view file's absolute path — the held path as it is when it is absolute, otherwise
// resolved against the view workspace's folder. Nothing is guessed: a workspace Orca does not
// list, or one it names no project for, refuses. Not a temper read, so no grant gate; it writes
// nothing anywhere.
import { isAbsolute, resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { HandoffPlaceInput, HandoffPlaceOutput } from './protocol'

export async function handoffPlace(orca: OrcaWorkerApi, input: HandoffPlaceInput): Promise<HandoffPlaceOutput> {
  if (typeof input?.workspaceId !== 'string' || input.workspaceId.trim() === '') {
    return { state: 'refused', message: 'the view names no workspace, so no agent was started beside it' }
  }
  if (typeof input.path !== 'string' || input.path.trim() === '') {
    return { state: 'refused', message: 'the view names no file, so no agent was started to write it' }
  }
  let listed
  try {
    listed = await orca.host.call('workspace.list')
  } catch (error) {
    return {
      state: 'refused',
      message: `Orca's workspaces could not be read: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const row = listed.workspaces.find((entry) => entry.id === input.workspaceId)
  if (row === undefined) {
    return {
      state: 'refused',
      message: "Orca no longer lists the view's workspace, so its project is unknown and no agent was started."
    }
  }
  const projectId = row.projectId ?? null
  if (projectId === null || projectId.trim() === '') {
    return {
      state: 'refused',
      message: `Orca names no project for ${row.name}, so no workspace could be made beside it and no agent was started.`
    }
  }
  const path = isAbsolute(input.path) ? input.path : resolve(row.path, input.path)
  return { state: 'ok', projectId, workspace: row.name, path }
}

export function registerHandoffPlace(orca: OrcaWorkerApi): void {
  orca.panels.handle('temper.body.handoff-place', (input: HandoffPlaceInput) => handoffPlace(orca, input))
}
