// What the editor room reaches outside the plugin besides temper: git, to find the repository's
// common git dir and to ask whether anything under `.temper-views/` is tracked, and the clock
// that stamps the base's read time. One mutable seam, like `../deps.ts`, so a test can stand in
// a clock; the file system is the real one (tests use their own temporary repositories).
import { spawn } from 'node:child_process'
import type { CommandResult } from '../deps'

export type RunGit = (args: readonly string[], cwd: string) => Promise<CommandResult>

const defaultGit: RunGit = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn('git', [...args], { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    // No git on PATH reads as "not a repository": the open refuses rather than writing a file
    // it cannot keep out of one.
    child.on('error', (error) => resolve({ code: 127, stdout: '', stderr: String(error) }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })

export interface RoomDeps {
  git: RunGit
  now: () => Date
}

export const roomDeps: RoomDeps = {
  git: defaultGit,
  now: () => new Date()
}
