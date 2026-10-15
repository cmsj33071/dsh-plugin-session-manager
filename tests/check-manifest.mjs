/**
 * Structural check for the plugin: manifest contract, patch file, declared
 * exports, and cross-module consistency that a syntax check cannot see.
 *
 * Run with the bundled Node:
 *   node tests/check-manifest.mjs
 */

import { readFile, stat, mkdtemp, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
/** Record one assertion result. */
function check(label, condition, detail = '') {
  if (condition) console.log(`OK    ${label}`)
  else {
    failures += 1
    console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

check('the package is named', typeof manifest.name === 'string' && manifest.name.length > 0, manifest.name)
check('the package is ESM', manifest.type === 'module')
check('it is marked private, so it cannot be published by accident', manifest.private === true)

for (const [label, target] of [
  ['main', manifest.main],
  ['exports["."]', manifest.exports?.['.']?.default],
  ['exports["./client"]', manifest.exports?.['./client']],
  ['exports["./cordis.patch.yml"]', manifest.exports?.['./cordis.patch.yml']],
]) {
  check(`${label} points at a real file`, target !== undefined && (await stat(join(root, target)).then(() => true, () => false)), String(target))
}

check('the client half declares a platform', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client?.platform))
check('the client half declares its injects', Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0)
check('the bundle patch is declared', typeof manifest.dsh?.bundle?.patch === 'string', String(manifest.dsh?.bundle?.patch))

const patchFile = manifest.dsh?.bundle?.patch
const patch = await readFile(join(root, patchFile), 'utf8')
check('the patch inserts exactly one entry', (patch.match(/- id:/gu) ?? []).length === 1)
check('the patch names this package', patch.includes(manifest.name))

// The module ids the client bundles register must match what the entry requires,
// because the loader resolves plugin modules by exact id.
const clientEntry = await readFile(join(root, manifest.exports['./client']), 'utf8')
const entryId = /id:\s*"([^"]+)"/u.exec(clientEntry)?.[1]
check('the client entry registers under the package name', entryId === manifest.name, String(entryId))

const required = [...clientEntry.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1])

// A client plugin is exactly one module node. The loader materializes the
// bundle's own entry and nothing else, so a package-relative require — even to a
// file sitting right next to it — resolves against a table that has no entry for
// it and fails the whole plugin with "missed the module table". The shell then
// refuses to boot with "1 entry did not activate". Every helper must therefore
// live inside the entry factory.
const localRequires = required.filter((specifier) => specifier.startsWith(`${manifest.name}/`))
check(
  'the client entry requires nothing from its own package',
  localRequires.length === 0,
  `move these into the entry factory: ${localRequires.join(', ')}`,
)

// Only platform seed modules may be required by name.
const platformModules = required.filter((specifier) => specifier.startsWith('@deepseek-ai/'))
const declaredPlatform = new Set(['react', 'react/jsx-runtime', ...(manifest.dsh?.client?.external ?? [])])
const platformSeed = new Set([
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-slots',
])
for (const specifier of required) {
  if (specifier.startsWith('.')) continue
  const known = platformSeed.has(specifier) || declaredPlatform.has(specifier)
  check(`client request "${specifier}" is a platform module`, known)
}

// A sibling `lib/client/` directory would be dead weight the loader never reads.
const strayDir = join(root, 'lib', 'client')
const stray = await stat(strayDir).then((info) => info.isDirectory(), () => false)
check('no unloadable sibling client directory remains', stray === false, strayDir)

// Every declared inject must be a service the entry actually registers against,
// so a typo in the declaration cannot fail silently at runtime.
const declaredInjects = manifest.dsh.client.inject
const entryInject = /const inject = \[([^\]]+)\]/u.exec(clientEntry)?.[1] ?? ''
for (const service of declaredInjects) {
  check(`declared dependency "${service}" is a real package`, typeof service === 'string' && service.startsWith('@deepseek-ai/'), service)
}
// The loader rejects a declaration whose package is not actually loadable, so
// every declared dependency must appear in the captured archive inventory. The
// inventory ships inside this package under `tools/`; a sibling `tools/` in the
// surrounding workspace is accepted as well, so the check also runs where the
// extraction tooling lives.
const inventoryCandidates = [join(root, 'tools', 'asar-packages.txt'), join(root, '..', 'tools', 'asar-packages.txt')]
let inventory = ''
for (const candidate of inventoryCandidates) {
  inventory = await readFile(candidate, 'utf8').catch(() => '')
  if (inventory !== '') break
}
if (inventory === '') {
  console.log('SKIP  archive inventory not available; cannot verify declared dependencies resolve')
} else {
  for (const service of declaredInjects) {
    check(`declared dependency "${service}" exists in the archive inventory`, inventory.includes(service))
  }
}
// The runtime injects are service names, not package names, and the entry must
// declare the ones it reads from the context.
for (const service of ['slots', 'locale']) {
  check(`the entry declares the "${service}" service`, entryInject.includes(`"${service}"`), entryInject)
}

// A profile installs only the plugin's own dependencies, so the module must not
// import any harness-internal package at load time: an unresolvable import keeps
// the whole plugin out of the tree and the plugin silently never activates. This
// is checked by really importing it below, which is the only way to catch it.
const hostSource = await readFile(join(root, 'lib/index.js'), 'utf8')
const hostImports = [...hostSource.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1])
const externalHostImports = hostImports.filter((specifier) => !specifier.startsWith('.'))
check(
  'the host entry imports nothing but node builtins',
  externalHostImports.every((specifier) => specifier.startsWith('node:')),
  externalHostImports.join(', '),
)

let hostModule
try {
  // Windows absolute paths must be converted to file URLs for a dynamic import.
  hostModule = await import(pathToFileURL(join(root, 'lib/index.js')).href)
  check('the host entry imports cleanly', true)
} catch (error) {
  check('the host entry imports cleanly', false, `${error?.code ?? error?.name}: ${error?.message}`)
}

if (hostModule !== undefined) {
  check('the host entry exports apply', typeof hostModule.apply === 'function')
  check('the host entry exports its name', typeof hostModule.name === 'string')
  check('the host entry declares injects', Array.isArray(hostModule.inject))
  check('the host entry exposes config defaults', typeof hostModule.CONFIG_DEFAULTS === 'object')
  for (const service of ['commands', 'connection', 'sessions', 'sessionPersistence']) {
    check(`the host injects the ${service} service`, hostModule.inject.includes(service), hostModule.inject.join(', '))
  }

  // Activate against a stub context: a throw here is exactly what keeps the
  // plugin out of the tree at boot.
  //
  // The stub deliberately offers NO `homePaths` service and sets no DSH_HOME,
  // because that is the real desktop composition (verified against the running
  // host: `ctx.get('homePaths')` is undefined and `$DSH_HOME` is unset in that
  // process). An earlier version of this stub invented a `homePaths.dshHome`
  // value, which made the suite pass while the installed plugin resolved no home
  // at all and stayed permanently idle.
  const tempHome = await mkdtemp(join(tmpdir(), 'session-manager-manifest-'))
  const routes = []
  const commands = []
  const provided = new Map()
  const ctx = {
    get: (name) =>
      name === 'connection'
        ? { fetch: { register: (spec) => { routes.push({ path: spec.path, methods: spec.methods }) } } }
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
    hostModule.apply(ctx, { home: tempHome })
    check('the host entry activates against a composed context', true)
  } catch (error) {
    check('the host entry activates against a composed context', false, `${error?.name}: ${error?.message}`)
  }
  check('activation registers six routes', routes.length === 6, JSON.stringify(routes.map((route) => route.path)))
  check('activation registers the /sessions command', commands.includes('sessions'), commands.join(', '))
  check(
    'the declared inject list matches the services activation reads',
    hostModule.inject.length === 4,
    hostModule.inject.join(', '),
  )
  const manager = provided.get('sessionManager')
  check('activation provides the session-manager service', manager !== undefined)
  check(
    'the sessions root follows the resolved home',
    manager?.root === join(tempHome, 'sessions'),
    String(manager?.root),
  )
  // The activation marker is the only outside-the-process proof that this plugin
  // ran, so the path it is written to has to be the resolved home's.
  await new Promise((done) => setTimeout(done, 100))
  const marker = await readFile(join(tempHome, 'session-manager', 'active.json'), 'utf8').catch(() => '')
  const markerPayload = marker === '' ? {} : JSON.parse(marker)
  check('activation writes its marker under the resolved home', marker !== '', join(tempHome, 'session-manager'))
  check('the marker records how the home was resolved', markerPayload.homeSource === 'config.home', String(markerPayload.homeSource))
  check('the marker records the registered route count', markerPayload.routes === 6, String(markerPayload.routes))
  check('the marker records an empty failure list', Array.isArray(markerPayload.failures) && markerPayload.failures.length === 0, JSON.stringify(markerPayload.failures))
  check('activation creates no stray probe files', !(await readdir(join(tempHome, 'session-manager'))).some((name) => name.startsWith('probe-')), (await readdir(join(tempHome, 'session-manager'))).join(', '))
  check('activation leaves the sessions root untouched', (await readdir(tempHome)).join(',') === 'session-manager', (await readdir(tempHome)).join(','))

  // The production rule set: explicit config, then a non-blank $DSH_HOME, then
  // the operating-system home. `~/.dsh` is the branch the desktop host actually
  // takes, and it must not depend on any service being present.
  const explicit = hostModule.resolveHome({ get: () => undefined }, { home: tempHome })
  check('an explicit home wins', explicit.home === resolve(tempHome), String(explicit.home))
  const serviceHome = hostModule.resolveHome({ get: (name) => (name === 'homePaths' ? { dshHome: tempHome } : undefined) }, {})
  check('a homePaths service is honoured when present', serviceHome.home === resolve(tempHome), String(serviceHome.home))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = tempHome
  const fromEnv = hostModule.resolveHome({ get: () => undefined }, {})
  check('a non-blank DSH_HOME is honoured', fromEnv.home === resolve(tempHome), String(fromEnv.home))
  process.env.DSH_HOME = '   '
  const blankEnv = hostModule.resolveHome({ get: () => undefined }, {})
  check('a blank DSH_HOME falls through to the default home', blankEnv.home === join(homedir(), '.dsh'), String(blankEnv.home))
  // The desktop host starts WITHOUT DSH_HOME, so the untouched default is the
  // branch that has to work; it is asserted with the variable really absent.
  delete process.env.DSH_HOME
  const defaultHome = hostModule.resolveHome({ get: () => undefined }, {})
  check('the default home is the operating-system home plus .dsh', defaultHome.home === join(homedir(), '.dsh'), String(defaultHome.home))
  check('the default home names the rule that produced it', defaultHome.source === '~/.dsh', defaultHome.source)
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
}

console.log(`\nfailures=${failures}`)
process.exit(failures === 0 ? 0 : 1)
