/**
 * Prove the plugin as actually installed in a profile loads and activates.
 *
 * It imports the installed copy through its own resolved path — the exact path
 * the launcher's loader uses — so an unresolvable dependency or an activation
 * throw shows up here instead of as a plugin that silently never appears in the
 * tree. The stub context deliberately offers no `homePaths` service and sets no
 * `DSH_HOME`, because that is the real desktop composition.
 *
 * Usage:
 *   node tools/verify-installed-plugin.mjs [profile-dir]
 *
 * `profile-dir` defaults to `$DSH_PROFILE_DIR`, then `~/.dsh/profiles/desktop`.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshHome = process.env.DSH_HOME?.trim() === undefined || process.env.DSH_HOME.trim() === ''
  ? join(homedir(), '.dsh')
  : process.env.DSH_HOME.trim()
const profileDir = process.argv[2] ?? process.env.DSH_PROFILE_DIR ?? join(dshHome, 'profiles', 'desktop')
const installed = join(profileDir, 'node_modules', 'dsh-plugin-session-manager')

let failures = 0
/** Record one assertion result. */
function check(label, condition, detail = '') {
  if (condition) console.log(`OK    ${label}`)
  else {
    failures += 1
    console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// 1. The installed manifest must declare no runtime dependency: a profile
//    installs only what the plugin declares, and an unresolvable import would
//    keep the whole module out of the tree.
const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
const declared = Object.keys(manifest.dependencies ?? {})
check('the installed manifest declares no runtime dependencies', declared.length === 0, declared.join(', '))

// 2. Every non-relative import in the installed sources must be a node builtin.
for (const rel of ['lib/index.js', 'lib/operations.js', 'lib/session-tree.js', 'lib/log-reader.js', 'lib/trash.js', 'lib/ownership.js']) {
  const source = await readFile(join(installed, rel), 'utf8')
  const externals = [...source.matchAll(/from\s+'([^']+)'/gu)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith('.'))
  check(
    `${rel} imports only node builtins`,
    externals.every((specifier) => specifier.startsWith('node:')),
    externals.join(', '),
  )
}

// 3. The installed host half must import and activate.
let plugin
try {
  plugin = await import(pathToFileURL(join(installed, 'lib/index.js')).href)
  check('the installed host entry imports', true)
} catch (error) {
  check('the installed host entry imports', false, `${error?.code ?? error?.name}: ${error?.message}`)
}
if (plugin === undefined) {
  console.log(`\nfailures=${failures}`)
  process.exit(1)
}

const routes = []
const commands = []
const provided = new Map()
// No `homePaths` service and no `DSH_HOME`, exactly like the desktop host
// process: `ctx.get('homePaths')` is undefined there and the launcher starts
// without the variable, so the plugin's own `~/.dsh` default is the branch that
// has to work.
const ctx = {
  get: (name) =>
    name === 'connection'
      ? { fetch: { register: (spec) => routes.push(spec.path) } }
      : name === 'commands'
        ? { register: (definition) => { commands.push(definition.name); return () => {} } }
        : name === 'sessions'
          ? { get: () => undefined, list: () => [], flush: async () => {} }
          : undefined,
  provide: (name, value) => provided.set(name, value),
  effect: (fn) => fn(),
  logger: { warn: (message) => console.log(`      warn: ${message}`) },
}
try {
  plugin.apply(ctx, {})
  check('the installed host half activates', true)
} catch (error) {
  check('the installed host half activates', false, `${error?.name}: ${error?.message}`)
}
check('it registers six routes', routes.length === 6, routes.join(', '))
check('it registers the /sessions command', commands.includes('sessions'), commands.join(', '))
const manager = provided.get('sessionManager')
check('it publishes a session-manager service', manager !== undefined)
if (manager !== undefined) {
  check(
    'the sessions root resolves to the real store',
    manager.root === join(dshHome, 'sessions'),
    `${manager.root} (expected ${join(dshHome, 'sessions')})`,
  )
}

// 4. The installed client bundle must be present and register under the id the
//    loader expects from the manifest's exports map.
const clientRel = manifest.exports?.['./client']
const client = await readFile(join(installed, clientRel), 'utf8')
const clientId = /id:\s*"([^"]+)"/u.exec(client)?.[1]
check('the installed client bundle registers under the package name', clientId === manifest.name, String(clientId))

console.log(`\nfailures=${failures}`)
process.exit(failures === 0 ? 0 : 1)
