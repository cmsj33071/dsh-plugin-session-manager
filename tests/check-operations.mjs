/**
 * End-to-end check of the session manager against a disposable copy of a real
 * sessions root. Nothing here ever touches the real store: the root is copied
 * into a temporary directory first, and every mutation happens on the copy.
 *
 * Run with the bundled Node:
 *   node tests/check-operations.mjs <real-sessions-root>
 */

import { cp, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../lib/operations.js'
import { scanSessionDirectories } from '../lib/session-tree.js'
import { listTrash, restoreTrashEntry, trashRoot } from '../lib/trash.js'

const realRoot = process.argv[2]
if (realRoot === undefined) {
  console.error('usage: check-operations.mjs <real-sessions-root>')
  process.exit(2)
}

let failures = 0
/** Record one assertion result. */
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`OK    ${label}`)
  } else {
    failures += 1
    console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-session-manager-check-'))
const home = join(sandbox, 'home')
const root = join(home, 'sessions')
await cp(realRoot, root, { recursive: true })
console.log(`sandbox home: ${home}\n`)

const config = {
  sessionsRoot: root,
  trashRetentionDays: 30,
  trackOwnership: true,
  allowForceRemoveLive: true,
  ownershipIndexPath: join(home, 'session-manager', 'owned-sessions.json'),
  trashRoot: trashRoot(home),
}
const manager = new SessionManager({ sessions: undefined, sessionPersistence: undefined, sessionQuery: undefined, home, config })

const before = await scanSessionDirectories(root)
const hasRoot = (header) => typeof header?.parentSession !== 'string'
const rootRecord = before.find((record) => record.id !== undefined && hasRoot(record.header))
const childRecord = before.find((record) => record.id !== undefined && typeof record.header?.parentSession === 'string')

check('scan finds session directories', before.length >= 2, `found ${before.length}`)
check('scan derives ids from headers', before.every((record) => record.id !== undefined || record.unreadable !== undefined))
check('a root session exists', rootRecord !== undefined)
check('a child session exists', childRecord !== undefined)

const listed = await manager.list({})
check('list returns items', listed.items.length > 0, `items=${listed.items.length}`)
check('list reports the sessions root', listed.root === root)
check('list is sorted newest first', listed.items.every((item, i) => i === 0 || (listed.items[i - 1].createdAt ?? 0) >= (item.createdAt ?? 0)))
check('list marks nothing live without a session store', listed.items.every((item) => item.live === false))
check('list measures disk bytes', listed.items.some((item) => item.bytes > 0))

const summary = await manager.storageSummary()
check('storage summary counts sessions', summary.sessions === before.length, `${summary.sessions} vs ${before.length}`)
check('storage summary counts bytes', summary.bytes > 0, `${summary.bytes}`)

// --- export -----------------------------------------------------------------
const exportDir = join(sandbox, 'exports')
const exported = await manager.export({ ids: [rootRecord.id], includeDescendants: true, destination: exportDir })
check('export succeeds', exported.ok === true, JSON.stringify(exported.failures))
check('export writes an index', (await stat(join(exportDir, 'index.json'))).isFile())
const exportedLog = join(exportDir, 'sessions', rootRecord.id, 'session.jsonl')
const logText = await (await import('node:fs/promises')).readFile(exportedLog, 'utf8')
const logLines = logText.split('\n').filter((line) => line !== '')
check('exported log starts with the session header', JSON.parse(logLines[0]).type === 'session')
check('exported log has contiguous seq', logLines.slice(1).every((line, i) => JSON.parse(line).seq === i))
if (childRecord !== undefined) {
  const hasChild =
    exported.sessions.some((entry) => entry.id === childRecord.id) ||
    childRecord.header.parentSession !== rootRecord.id
  check('export included the direct descendant when it belongs to the root', hasChild)
}

// --- plan -------------------------------------------------------------------
const plan = await manager.plan(rootRecord.id)
check('plan succeeds for a stored session', plan.ok === true, JSON.stringify(plan))
check('plan lists the root plus its descendants', plan.ok && plan.entries.length === 1 + plan.descendants.length)
check('plan issues a token', typeof plan.token === 'string' && plan.token.length === 32)
check('plan reports bytes to reclaim', plan.ok && plan.bytes > 0, `${plan.bytes}`)
const planningMissing = await manager.plan('session-does-not-exist')
check('plan refuses an unknown session', planningMissing.ok === false && planningMissing.code === 'session/not-found')

const wrongToken = await manager.remove({ id: rootRecord.id, token: 'deadbeef', force: true })
check('remove refuses a bad token', wrongToken.ok === false && wrongToken.code === 'session/confirmation-mismatch')

// --- remove a leaf session --------------------------------------------------
const leaf = before
  .filter((record) => record.id !== undefined)
  .find((record) => !before.some((other) => other.header?.parentSession === record.id))
if (leaf !== undefined) {
  const leafPlan = await manager.plan(leaf.id)
  check('leaf plan needs no force', leafPlan.ok === true && leafPlan.requiresForce === false, JSON.stringify(leafPlan.blocked))
  const siblingDirs = (await readdir(join(root, leaf.project))).filter((n) => n !== leaf.directoryName)
  const removed = await manager.remove({ id: leaf.id, token: leafPlan.token })
  check('remove reports success', removed.ok === true, JSON.stringify(removed))
  check('remove moved the directory into trash', (await listTrash(home)).length === 1)
  check('remove left sibling directories alone', (await readdir(join(root, leaf.project))).length === siblingDirs.length)
  const afterRemove = await scanSessionDirectories(root)
  check('removed session is gone from a fresh scan', !afterRemove.some((record) => record.id === leaf.id))
  check('scan cache was invalidated', (await manager.list({})).items.length === listed.items.length - (leafPlan.entries.length))

  // restore the trashed directory and verify the session is discoverable again
  const entry = (await listTrash(home))[0]
  await restoreTrashEntry(entry.entry, leaf.directory)
  check('restore brings the session back', (await scanSessionDirectories(root)).some((record) => record.id === leaf.id))
}

// --- plan integrity on real lineage -----------------------------------------
// Group stored children by their recorded parent, then assert against the real
// shape rather than assuming one parent has exactly one child.
const childrenByParent = new Map()
for (const record of before) {
  const parent = record.header?.parentSession
  if (typeof parent !== 'string') continue
  const bucket = childrenByParent.get(parent) ?? []
  bucket.push(record)
  childrenByParent.set(parent, bucket)
}
if (childrenByParent.size === 0) {
  console.log('SKIP  no stored child session in this root; lineage check not applicable')
}
for (const [parent, children] of childrenByParent) {
  const parentRecord = before.find((record) => record.id === parent)
  if (parentRecord === undefined) {
    // The child is listed but its recorded parent has no directory here. The
    // child's own plan must flag that instead of pretending the chain is whole.
    const childPlan = await manager.plan(children[0].id)
    const blocked = childPlan.ok === true ? childPlan.blocked : []
    check(
      `an unlocatable parent (${parent}) is a blocking reason`,
      childPlan.ok === false || blocked.some((item) => item.reason === 'parent-missing'),
      `ok=${childPlan.ok} blocked=${JSON.stringify(blocked)}`,
    )
    continue
  }
  const parentPlan = await manager.plan(parent)
  const covered = parentPlan.ok === true ? parentPlan.descendants : []
  const missing = children.filter((child) => !covered.includes(child.id)).map((child) => child.id)
  check(
    `the plan for ${parent} covers all ${children.length} stored child session(s)`,
    missing.length === 0,
    `descendants=${JSON.stringify(covered)} missing=${JSON.stringify(missing)}`,
  )
}

await rm(sandbox, { recursive: true, force: true })
console.log(`\nfailures=${failures}`)
process.exit(failures === 0 ? 0 : 1)

