// Home's ways in, each by a status the person picks (ruling 24): Tasks by backlog, in progress
// or done, Goals by active or done. Sessions take no toggle. The default status is the one
// temper-design's WAYS_IN filters on, under WAYS_IN's own scope words, so Home opens as
// temper-ui's home does. Every toggle keeps the way's `owner: '@me'` scope (R2) and changes only
// the stage or status the read narrows on.
//
// Interim, like WAY_IN_MAX: temper-design publishes the scope words for each way's default
// status only, so the words for the other statuses live here until it publishes them.
import { WAYS_IN } from '../vendor/temper-design.mjs'

/** One status a way in can be read by: the filter value, its word, and its scope sentence part. */
export interface WayStatus {
  value: string
  label: string
  scope: string
}

/** A toggled way in: the region's own name, the filter key it narrows on, and its statuses. */
export interface WayToggle {
  /** The region's heading word: "tasks" names the list whatever stage it shows. */
  name: string
  key: 'stage' | 'status'
  statuses: readonly WayStatus[]
  /** The status WAYS_IN filters on: Home's default. */
  defaultStatus: string
}

function defaultScope(id: string): string {
  const way = WAYS_IN.find((entry) => entry.id === id)
  if (!way) {
    throw new Error(`WAYS_IN names no ${id} way`)
  }
  return way.scope
}

export const WAY_TOGGLES: Readonly<Record<string, WayToggle>> = {
  goals: {
    name: 'goals',
    key: 'status',
    defaultStatus: 'active',
    statuses: [
      { value: 'active', label: 'active', scope: defaultScope('goals') },
      { value: 'done', label: 'done', scope: 'done goals of yours' }
    ]
  },
  tasks: {
    name: 'tasks',
    key: 'stage',
    defaultStatus: 'in-progress',
    statuses: [
      { value: 'backlog', label: 'backlog', scope: 'backlog tasks of yours' },
      { value: 'in-progress', label: 'in progress', scope: defaultScope('tasks') },
      { value: 'done', label: 'done', scope: 'done tasks of yours' }
    ]
  }
}

/** The status entry a way in is read by, or null when the way takes no toggle or not that one. */
export function wayStatus(id: string, value: string): WayStatus | null {
  return WAY_TOGGLES[id]?.statuses.find((status) => status.value === value) ?? null
}
