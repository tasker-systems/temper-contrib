// The origin resolver: the CLI's own precedence (env over config file), and the config parse.
import { assert, test } from 'orca/testing'
import { apiUrlFromConfigToml, globalConfigPath, resolveApiOrigin } from './origin'

const CONFIG = `# temper config
[vault]
path = "~/kb-vault"

[cloud]
api_url = "https://temper-configured.example"

[memory]
index_path = "~/memory.md"
`

test('reads [cloud] api_url from the CLI config', () => {
  assert.equal(apiUrlFromConfigToml(CONFIG), 'https://temper-configured.example')
})

test('ignores api_url under another table and tolerates comments and whitespace', () => {
  const config = '[other]\napi_url = "https://wrong.example"\n[cloud]\n  api_url = "https://right.example" # the one\n'
  assert.equal(apiUrlFromConfigToml(config), 'https://right.example')
  assert.equal(apiUrlFromConfigToml('[other]\napi_url = "https://wrong.example"\n'), null)
  assert.equal(apiUrlFromConfigToml('[cloud]\n# api_url = "https://commented.example"\n'), null)
})

test('resolves as the CLI does: TEMPER_API_URL over the config file', () => {
  assert.equal(
    resolveApiOrigin({ TEMPER_API_URL: 'https://env.example' }, () => CONFIG),
    'https://env.example'
  )
  assert.equal(resolveApiOrigin({}, () => CONFIG), 'https://temper-configured.example')
  // No config on disk, nothing in the environment: the worker cannot guess an instance.
  assert.equal(resolveApiOrigin({}, () => null), null)
})

test('the config path follows $TEMPER_GLOBAL_CONFIG, then ~/.config/temper', () => {
  assert.equal(globalConfigPath({ TEMPER_GLOBAL_CONFIG: '/tmp/custom.toml' }), '/tmp/custom.toml')
  assert.equal(globalConfigPath({ HOME: '/home/person' }), '/home/person/.config/temper/config.toml')
})
