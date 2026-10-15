/**
 * Focused check of the deletion safety rules on a synthetic session tree:
 * descendant closure, the parent-with-surviving-child block, the confirmation
 * token binding, and the delete ordering that never orphans a child.
 *
 * Run with the bundled Node:
 *   node tests/check-lineage.mjs
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../lib/operations.js'
import { listTrash, restoreTrashEntry, trashRoot } from '../lib/trash.js'

let failures = 0
/** Record one assertion result. */
function check(label, condition, detail = '') {
  if (condition) console.log(`OK    ${label}`)
  else {
    failures += 1
    console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-session-manager-lineage-'))
const home = join(sandbox, 'home')
const root = join(home, 'sessions')
const project = join(root, '--C-proj--')

/**
 * Materialize one plain-JSONL session directory, which the plugin reads through
 * its uncompressed path.
 */
async function writeSession(id, header, events = []) {
  const dir = join(project, id)
  await mkdir(dir, { recursive: true })
  const lines = [JSON.stringify({ type: 'session', version: 4, isSeeded: false, ...header, id })]
  for (const [index, event] of events.entries()) lines.push(JSON.stringify({ seq: index, ...event }))
  await writeFile(join(dir, 'session.v4.jsonl'), `${lines.join('\n')}\n`, 'utf8')
  return dir
}

const grandparent = await writeSession('session-a', { createdAt: 3000, cwd: 'C:\\proj' }, [{ type: 'user/message' }])
const parent = await writeSession('session-b', { createdAt: 2000, cwd: 'C:\\proj', parentSession: 'session-a' }, [{ type: 'user/message' }])
const child = await writeSession('session-c', { createdAt: 1000, cwd: 'C:\\proj', parentSession: 'session-b' })
const unrelated = await writeSession('session-d', { createdAt: 500, cwd: 'C:\\proj' })

const config = {
  sessionsRoot: root,
  trashRetentionDays: 30,
  trackOwnership: true,
  allowForceRemoveLive: true,
  ownershipIndexPath: join(home, 'session-manager', 'owned-sessions.json'),
  trashRoot: trashRoot(home),
}
const manager = new SessionManager({ sessions: undefined, sessionPersistence: undefined, sessionQuery: undefined, home, config })

const planA = await manager.plan('session-a')
check('closure walks the whole chain', planA.ok && planA.descendants.join(',') === 'session-b,session-c', JSON.stringify(planA.descendants))
check('plan spans three directories', planA.ok && planA.entries.length === 3, `${planA.entries?.length}`)
check('plan is not blocked when every descendant is included', planA.ok && planA.blocked.length === 0, JSON.stringify(planA.blocked))
check('plan reports a force requirement only when blocked', planA.ok && planA.requiresForce === false)

const planD = await manager.plan('session-d')
check('a childless session plans alone', planD.ok && planD.descendants.length === 0 && planD.entries.length === 1)

// The token binds to the exact tree that was previewed, so a plan made before
// the tree changed cannot be replayed afterwards.
const stalePlan = await manager.plan('session-a')
await writeSession('session-e', { createdAt: 100, cwd: 'C:\\proj', parentSession: 'session-a' })
const staleAttempt = await manager.remove({ id: 'session-a', token: stalePlan.token, force: true })
check('a stale token is refused after the tree changed', staleAttempt.ok === false && staleAttempt.code === 'session/confirmation-mismatch', JSON.stringify(staleAttempt.code))

// Regression: the directory tree belongs to the persistence backend, so a
// session that appeared since the last operation must be visible to the next
// plan. A reused scan would silently drop it from the descendant closure and
// produce a token for a deletion that orphans it.
const freshPlan = await manager.plan('session-a')
check(
  'a newly stored child appears in the next plan',
  freshPlan.ok === true && freshPlan.descendants.includes('session-e'),
  JSON.stringify(freshPlan.descendants),
)
const freshAttempt = await manager.remove({ id: 'session-a', token: freshPlan.token, force: false })
check(
  'the refreshed plan covers the new child',
  freshAttempt.ok === true && freshAttempt.removed.map((item) => item.id).sort().join(',') === 'session-a,session-b,session-c,session-e',
  JSON.stringify(freshAttempt.removed?.map((item) => item.id)),
)
// Put the tree back for the remaining checks.
for (const id of ['session-e', 'session-b', 'session-c', 'session-a']) {
  const entry = (await listTrash(home)).find((item) => item.id === id)
  if (entry !== undefined) await restoreTrashEntry(entry.entry, join(project, id))
}

// A session the backend knows about but the directory scan cannot see must
// block a plan that would remove it, because its lineage cannot be walked.
const invisibleManager = new SessionManager({
  sessions: undefined,
  sessionPersistence: { list: async () => [{ header: { id: 'session-ghost', createdAt: 1 } }] },
  sessionQuery: undefined,
  home,
  config,
})
const ghostPlan = await invisibleManager.plan('session-ghost')
check('an unindexed session has no plan', ghostPlan.ok === false && ghostPlan.code === 'session/not-found')
const visibleWithGhost = await invisibleManager.plan('session-a')
check('an unindexed session is reported', visibleWithGhost.ok && visibleWithGhost.unindexed.includes('session-ghost'), JSON.stringify(visibleWithGhost.unindexed))
check('an unrelated unindexed session does not block', visibleWithGhost.ok && visibleWithGhost.blocked.length === 0, JSON.stringify(visibleWithGhost.blocked))

// Deleting a parent must move children first: after the operation no directory
// may exist whose recorded parent has already been trashed.
const planB = await manager.plan('session-b')
const removed = await manager.remove({ id: 'session-b', token: planB.token })
check('removing a parent succeeds', removed.ok === true, JSON.stringify(removed))
check('removal is ordered child before parent', removed.removed.map((item) => item.id).join(',') === 'session-c,session-b', JSON.stringify(removed.removed?.map((item) => item.id)))
const remaining = await readdir(project)
check('the parent and child directories are gone', !remaining.includes('session-b') && !remaining.includes('session-c'), remaining.join(','))
check('unrelated sessions are untouched', remaining.includes('session-a') && remaining.includes('session-d'))
const trashed = await listTrash(home)
check('both directories are recoverable from trash', trashed.length === 2, `${trashed.length}`)
check('trash entries record the session id', trashed.every((entry) => typeof entry.id === 'string'))

// Export a session that only exists on disk, exercising the raw-frame reader.
const exportDir = join(sandbox, 'out')
const exported = await manager.export({ ids: ['session-a'], includeDescendants: false, destination: exportDir })
check('raw export succeeds', exported.ok === true, JSON.stringify(exported.failures))
const text = await (await import('node:fs/promises')).readFile(join(exportDir, 'sessions', 'session-a', 'session.jsonl'), 'utf8')
check('raw export preserves the header', JSON.parse(text.split('\n')[0]).id === 'session-a')
check('raw export preserves events', text.trim().split('\n').length === 2)

// The cross-process write-lock probe is the plugin's only way to notice a
// foreign writer, and it works by opening a write handle. Two things have to
// hold: a held lease blocks the plan, and a historical log generation is never
// write-opened at all (the backend would publish a migrated successor, and a
// preview must stay read-only).
let probeOpens = 0
const heldManager = new SessionManager({
  sessions: undefined,
  sessionPersistence: {
    list: async () => [],
    open: async () => {
      probeOpens += 1
      const error = new Error('owned elsewhere')
      error.name = 'SessionAlreadyOwnedError'
      throw error
    },
  },
  sessionQuery: undefined,
  home,
  config,
})
const heldPlan = await heldManager.plan('session-d')
check('a held write lease is probed once', probeOpens === 1, `opens=${probeOpens}`)
check(
  'a held write lease blocks the plan',
  heldPlan.ok === true && heldPlan.blocked.some((item) => item.id === 'session-d' && item.reason === 'writer-held'),
  JSON.stringify(heldPlan.blocked),
)
check('a held write lease requires force', heldPlan.requiresForce === true)
check('the plan records the probe outcome', heldPlan.entries[0]?.lockProbe === 'held', String(heldPlan.entries[0]?.lockProbe))
check('the plan records the log generation', heldPlan.entries[0]?.logGeneration === 4, String(heldPlan.entries[0]?.logGeneration))
const heldAttempt = await heldManager.remove({ id: 'session-d', token: heldPlan.token, force: true })
check(
  'removal is refused while the lease is held',
  heldAttempt.ok === false && heldAttempt.code === 'session/writer-held',
  JSON.stringify(heldAttempt.code),
)
check('the refused removal did not delete anything', (await readdir(project)).includes('session-d'))

let freeOpens = 0
const freeManager = new SessionManager({
  sessions: undefined,
  sessionPersistence: {
    list: async () => [],
    open: async () => {
      freeOpens += 1
      return { close: async () => {} }
    },
  },
  sessionQuery: undefined,
  home,
  config,
})
const freePlan = await freeManager.plan('session-d')
check('a free lease is probed once', freeOpens === 1, `opens=${freeOpens}`)
check('a free lease does not block the plan', freePlan.ok === true && freePlan.blocked.length === 0, JSON.stringify(freePlan.blocked))
check('a free lease is recorded as free', freePlan.entries[0]?.lockProbe === 'free', String(freePlan.entries[0]?.lockProbe))

let historicalOpens = 0
// A directory holding ONLY a historical generation, so the generation selector
// really lands on v3 instead of the newer v4 sitting beside it.
await mkdir(join(project, 'session-hist'), { recursive: true })
await writeFile(
  join(project, 'session-hist', 'session.v3.jsonl'),
  `${JSON.stringify({ type: 'session', version: 3, id: 'session-hist', createdAt: 1000, cwd: 'C:\\proj' })}\n`,
  'utf8',
)
const historicalManager = new SessionManager({
  sessions: undefined,
  sessionPersistence: {
    list: async () => [],
    open: async () => {
      historicalOpens += 1
      return { close: async () => {} }
    },
  },
  sessionQuery: undefined,
  home,
  config,
})
const historicalPlan = await historicalManager.plan('session-hist')
check('a historical generation is not write-opened', historicalOpens === 0, `opens=${historicalOpens}`)
check(
  'a historical generation is recorded as not probed',
  historicalPlan.entries[0]?.lockProbe === 'not-probed',
  String(historicalPlan.entries[0]?.lockProbe),
)
check('the historical generation is recorded', historicalPlan.entries[0]?.logGeneration === 3, String(historicalPlan.entries[0]?.logGeneration))
check(
  'a historical generation does not block the plan by itself',
  historicalPlan.ok === true && historicalPlan.blocked.length === 0,
  JSON.stringify(historicalPlan.blocked),
)
check('the current generation is still probed', freePlan.entries[0]?.logGeneration === 4, String(freePlan.entries[0]?.logGeneration))
await rm(join(project, 'session-hist'), { recursive: true, force: true })

// Retention pruning must respect the window and remove only old entries.
const pruned = await manager.prune()
check('prune keeps entries inside the window', pruned.removed.length === 0, JSON.stringify(pruned))

await rm(sandbox, { recursive: true, force: true })
console.log(`\nfailures=${failures}`)
process.exit(failures === 0 ? 0 : 1)


