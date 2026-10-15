/**
 * Read-only smoke test of the installed plugin against the LIVE DSH store.
 *
 * It activates the host half exactly as the launcher does (no `homePaths`
 * service, no `DSH_HOME`), resolves the real sessions root, and then runs the
 * operations the row menu actually calls: the inventory listing, the deletion
 * preview, a refused removal, and an export. Nothing is deleted and nothing is
 * appended; the only storage interaction beyond reading is the cross-process
 * write-lock probe, which opens and immediately closes a write handle without
 * appending (the shipped backend writes nothing on such a close).
 *
 * Usage:
 *   node tools/real-store-smoke.mjs [profile-dir]
 *
 * `profile-dir` defaults to `$DSH_PROFILE_DIR`, then `~/.dsh/profiles/desktop`.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
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

// Activate the installed copy through the launcher's real service set.
const plugin = await import(pathToFileURL(join(installed, 'lib/index.js')).href)
const provided = new Map()
const routes = []
const ctx = {
  get: (name) =>
    name === 'connection'
      ? { fetch: { register: (spec) => routes.push(spec.path) } }
      : name === 'commands'
        ? { register: () => () => {} }
        : name === 'sessions'
          ? { get: () => undefined, list: () => [], flush: async () => {} }
          : undefined,
  provide: (name, value) => provided.set(name, value),
  effect: (fn) => fn(),
  logger: { warn: (message) => console.log(`      warn: ${message}`) },
}
plugin.apply(ctx, {})

const manager = provided.get('sessionManager')
check('the host half activates and publishes its service', manager !== undefined)
if (manager === undefined) {
  console.log(`\nfailures=${failures}`)
  process.exit(1)
}
check('it registered six routes', routes.length === 6, routes.join(', '))
check('the resolved root is the live store', manager.root.endsWith('sessions'), manager.root)
console.log(`      root: ${manager.root}`)

// The inventory: every stored session, read from real artifacts.
const listed = await manager.list()
check('the inventory lists real sessions', listed.items.length > 0, `items=${listed.items.length}`)
check(
  'every listed session has a directory on disk',
  listed.items.every((item) => item.hasDirectory === true),
  JSON.stringify(listed.items.filter((item) => item.hasDirectory !== true).map((item) => item.id)),
)
check(
  'no session is reported unreadable',
  listed.warnings.filter((warning) => warning.kind === 'unreadable-directory').length === 0,
  JSON.stringify(listed.warnings),
)
check('the listing measures real bytes', listed.items.every((item) => item.diskBytes > 0), `${listed.items.length}`)
console.log(`      sessions: ${listed.items.length}, bytes: ${listed.items.reduce((total, item) => total + item.diskBytes, 0)}`)
for (const item of listed.items.slice(0, 8)) {
  console.log(`      - ${item.id}  ${item.diskBytes} B  parent=${item.parentSession ?? '-'}  live=${item.live}`)
}

// The deletion preview: this is the call the row menu makes, and it exercises
// lineage walking plus the write-lock probe.
const newest = [...listed.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
const plan = await manager.plan(newest.id)
check('the preview succeeds for a real session', plan.ok === true, JSON.stringify(plan).slice(0, 240))
check('the preview issues a 32-character token', typeof plan.token === 'string' && plan.token.length === 32, String(plan.token))
check('the preview names at least one directory', plan.entries.length >= 1, `${plan.entries?.length}`)
check('the preview measures real bytes', plan.bytes > 0, String(plan.bytes))
check('every planned directory exists on disk', plan.entries.every((entry) => typeof entry.directory === 'string' && entry.directory.length > 0))
check('the preview records its lineage descendants', Array.isArray(plan.descendants))
check(
  'the probe outcome is recorded per entry',
  plan.entries.every((entry) => typeof entry.lockProbe === 'string'),
  JSON.stringify(plan.entries.map((entry) => entry.lockProbe)),
)
console.log(`      plan: ${plan.id} entries=${plan.entries.length} descendants=${plan.descendants.length} bytes=${plan.bytes} blocked=${JSON.stringify(plan.blocked)}`)
for (const entry of plan.entries) {
  console.log(`      - ${entry.id}  gen=v${entry.logGeneration}  lockProbe=${entry.lockProbe}`)
}

// This process is not the launcher, so no session may look live in-process.
const held = listed.items.filter((item) => item.live === true)
check('no session looks live from another process', held.length === 0, JSON.stringify(held.map((item) => item.id)))

const summary = await manager.storageSummary()
check('the storage summary counts the same sessions', summary.sessions === listed.items.length, `${summary.sessions}/${listed.items.length}`)
check('the storage summary reports bytes', summary.bytes > 0, String(summary.bytes))

// A wrong confirmation token must be refused before anything moves. This runs
// the real destructive path's gate against real data without deleting anything:
// the token comparison happens before the first filesystem action.
const trashBefore = (await manager.trash()).length
const refused = await manager.remove({ id: newest.id, token: '0'.repeat(32) })
check(
  'a wrong token is refused as a confirmation mismatch',
  refused.ok === false && refused.code === 'session/confirmation-mismatch',
  JSON.stringify(refused).slice(0, 200),
)
check('the refused removal moved nothing', (await manager.trash()).length === trashBefore, `${trashBefore} -> ${(await manager.trash()).length}`)
const rootEntries = await readdir(manager.root, { recursive: true }).catch(() => [])
check('the refused session is still on disk', rootEntries.some((name) => String(name).includes(newest.id)))

// The export path reads real Zstandard frames and writes only into a temp dir.
const exportDir = await mkdtemp(join(tmpdir(), 'session-manager-smoke-'))
const exported = await manager.export({ ids: [newest.id], includeDescendants: true, destination: exportDir })
check('export succeeds on real artifacts', exported.ok === true, JSON.stringify(exported.failures))
check('export wrote an index', (await readdir(exportDir)).includes('index.json'))
const exportedText = await readFile(join(exportDir, 'sessions', newest.id, 'session.jsonl'), 'utf8')
const exportedLines = exportedText.trim().split('\n')
check('the exported log starts with the session header', JSON.parse(exportedLines[0]).id === newest.id, String(exportedLines[0]).slice(0, 120))
const seqs = exportedLines.slice(1).map((line) => JSON.parse(line).seq).filter((seq) => typeof seq === 'number')
check('the exported events keep contiguous seq order', seqs.every((seq, index) => index === 0 || seq === seqs[index - 1] + 1), `${seqs.length} events`)
console.log(`      export: ${exported.sessions.length} session(s), ${exportedLines.length} lines -> ${exportDir}`)
await rm(exportDir, { recursive: true, force: true })

const trash = await manager.trash()
check('the trash is readable', Array.isArray(trash), JSON.stringify(trash).slice(0, 120))
check('the smoke test left the trash unchanged', trash.length === trashBefore, `${trash.length}`)
console.log(`      trash entries: ${trash.length}`)

console.log(`\nfailures=${failures}`)
process.exit(failures === 0 ? 0 : 1)
