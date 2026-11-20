// What reaches outside the plugin: the temper CLI that mints the borrowed token, fetch, and
// (for the API origin the CLI would use) the CLI's global config file — config.toml only, never
// auth.json. All three live behind one mutable seam so a test can stand the whole outside
// world in before it mounts the worker; the live defaults talk to the real machine.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Runs the temper CLI, keeping stdout and stderr apart, resolving with its exit code.
 * Callers decide what stdout means (the CLI prints its JSON error payload on stdout on failure,
 * so a non-zero `code` is what refuses — never the shape of stdout).
 */
export type RunCli = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<CommandResult>

/** temper-ts's `FetchLike`: a `Request` in, a `Response` out — not global fetch's `(url, init)`. */
export type FetchLike = (input: Request) => Promise<Response>

/** Reads a file as UTF-8; null when it does not exist (an unreadable file is still an error). */
export type ReadTextFile = (path: string) => string | null

export interface PluginDeps {
  run: RunCli
  fetch: FetchLike
  readTextFile: ReadTextFile
}

const defaultRun: RunCli = (args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn('temper', [...args], { env })
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
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })

const defaultReadTextFile: ReadTextFile = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export const deps: PluginDeps = {
  run: defaultRun,
  fetch: (input) => fetch(input),
  readTextFile: defaultReadTextFile
}
