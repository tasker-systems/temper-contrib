// What reaches outside the plugin: the temper CLI that mints the borrowed token and names the
// API origin it presents to (`temper auth status --format json`), the Orca CLI that names the
// agents this host can launch (`orca agent installed --json`), and fetch. Both live behind
// one mutable seam so a test can stand the whole outside world in before it mounts the worker;
// the live defaults talk to the real machine. Nothing here reads files — the plugin never
// touches temper's own config or auth store.
import { spawn } from 'node:child_process'

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

export interface PluginDeps {
  run: RunCli
  /** The Orca CLI — only ever `agent installed`, the launchable-agents question the host API
   *  does not answer; it runs the same host's own CLI, never the undocumented RPC beneath it. */
  runOrca: RunCli
  fetch: FetchLike
}

/** Spawns one CLI by program name, collecting stdout and stderr until close. */
const spawnCli =
  (program: string): RunCli =>
  (args, env) =>
    new Promise((resolve, reject) => {
      const child = spawn(program, [...args], { env })
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

export const deps: PluginDeps = {
  run: spawnCli('temper'),
  runOrca: spawnCli('orca'),
  fetch: (input) => fetch(input)
}
