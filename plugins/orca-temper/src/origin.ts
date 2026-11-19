// Where the temper API lives, answered the way the CLI answers it: `TEMPER_API_URL` first, then
// `[cloud] api_url` in the global config ($TEMPER_GLOBAL_CONFIG or ~/.config/temper/config.toml).
// The token is minted by the CLI and presented to the API the CLI is configured for — the two
// always come from the same deployment. A plugin setting may override it; the refusal to guess
// is deliberate: without a configured origin the worker cannot know which instance is the
// person's. (This reads config.toml only — never auth.json.)
//
// Interim: once `temper auth status --format json` reports the API origin, the worker takes it
// from there (through the same `deps.run` seam as `export-token`) and this parser is deleted.

/** The path the CLI loads its global config from: $TEMPER_GLOBAL_CONFIG, else the default. */
export function globalConfigPath(env: NodeJS.ProcessEnv): string {
  return env.TEMPER_GLOBAL_CONFIG ?? `${env.HOME}/.config/temper/config.toml`
}

/** One TOML basic or literal string's value. Minimal on purpose: config.toml writers use these. */
function tomlStringValue(raw: string): string | null {
  const basic = /^"((?:[^"\\]|\\.)*)"/.exec(raw)
  if (basic) {
    // A TOML basic string unescapes exactly as JSON's string body does.
    return JSON.parse(`"${basic[1]}"`) as string
  }
  const literal = /^'([^']*)'/.exec(raw)
  if (literal) {
    return literal[1]
  }
  return null
}

/** The `api_url` under the `[cloud]` table of temper's config.toml, or null. */
export function apiUrlFromConfigToml(content: string): string | null {
  let inCloud = false
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    if (line.startsWith('[')) {
      inCloud = /^\[\s*cloud\s*\]$/.test(line)
      continue
    }
    if (inCloud) {
      const assignment = /^api_url\s*=\s*(.+)$/.exec(line)
      if (assignment) {
        return tomlStringValue(assignment[1])
      }
    }
  }
  return null
}

/**
 * The CLI's precedence: `TEMPER_API_URL` takes priority over `[cloud] api_url`
 * (temper-client's `api_url()`), so the plugin's read and the CLI's mint name the same instance.
 */
export function resolveApiOrigin(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string | null
): string | null {
  const fromEnv = env.TEMPER_API_URL
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim()
  }
  const content = readFile(globalConfigPath(env))
  if (content === null) {
    return null
  }
  const fromConfig = apiUrlFromConfigToml(content)
  return fromConfig !== null && fromConfig.trim() !== '' ? fromConfig.trim() : null
}
