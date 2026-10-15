/**
 * Recoverable removal for session artifacts.
 *
 * Deletion never unlinks a session directory outright. The directory is moved
 * into a plugin-owned trash area first, which makes the operation atomic on one
 * volume, keeps a restore path for an accidental deletion, and avoids the
 * Windows failure mode where a live writer's open handle makes an in-place
 * recursive delete fail halfway through and leave a mutilated directory.
 *
 * @module dsh-plugin-session-manager/trash
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Current on-disk shape of one trash entry's manifest. */
const MANIFEST_VERSION = 1

/**
 * The trash root inside one DSH home directory.
 * @param home - the resolved DSH home directory.
 * @returns the absolute trash path.
 */
export function trashRoot(home) {
  return join(home, 'session-manager', 'trash')
}

/**
 * One trash entry's directory name. Timestamp-first keeps entries sortable, and
 * the session id is suffixed rather than parsed back out, because the id is
 * always read from the manifest.
 * @param id - the trashed session id.
 * @param now - clock injection for deterministic tests.
 * @returns a single path segment.
 */
function entryName(id, now) {
  const safe = id.replace(/[^A-Za-z0-9_-]/gu, '_')
  return `${new Date(now()).toISOString().replace(/[:.]/gu, '-')}-${safe}`
}

/**
 * Move one session's directory into the trash and record why it was removed.
 * @param options - home, session directory, session id, and reason.
 * @returns the trash entry path and whether the manifest was written.
 */
export async function trashSessionDirectory({ home, directory, id, reason, now = Date.now }) {
  const root = trashRoot(home)
  const entry = join(root, entryName(id, now))
  const keep = join(entry, 'session')
  await mkdir(entry, { recursive: true })
  await rename(directory, keep)
  const manifest = {
    version: MANIFEST_VERSION,
    id,
    reason: reason ?? 'deleted by session-manager',
    removedAt: now(),
    originalName: directory,
  }
  let manifestWritten = true
  try {
    await writeFile(join(entry, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  } catch {
    // A missing manifest only costs the recorded reason; the artifacts are
    // already safe in the trash, so this must not fail the deletion.
    manifestWritten = false
  }
  return { entry, manifestWritten }
}

/**
 * Prune trash entries older than a retention window.
 *
 * Age comes from the manifest when present and otherwise from the entry name's
 * leading timestamp, so an entry never becomes unprunable just because its
 * manifest write failed.
 * @param home - the resolved DSH home directory.
 * @param retentionDays - entries older than this many days are removed.
 * @param now - clock injection for deterministic tests.
 * @returns the entry paths that were removed and the ones that failed.
 */
export async function pruneTrash(home, retentionDays, now = Date.now) {
  const root = trashRoot(home)
  const removed = []
  const failed = []
  if (retentionDays <= 0) return { removed, failed }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed, failed }
    throw error
  }
  const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    const removedAt = await entryRemovalTime(path, entry.name)
    if (removedAt === undefined || removedAt > cutoff) continue
    try {
      await rm(path, { recursive: true, force: true })
      removed.push(path)
    } catch {
      failed.push(path)
    }
  }
  return { removed, failed }
}

/**
 * Read one trash entry's removal time.
 * @param path - the entry directory.
 * @param name - the entry directory name.
 * @returns epoch ms, or undefined when neither source yields a valid time.
 */
async function entryRemovalTime(path, name) {
  try {
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
    if (typeof manifest?.removedAt === 'number' && Number.isFinite(manifest.removedAt)) {
      return manifest.removedAt
    }
  } catch {
    // Fall through to the name-derived timestamp.
  }
  const prefix = name.slice(0, 24)
  const parsed = Date.parse(prefix.replace(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{3})/u, '$1-$2-$3T$4:$5:$6.$7Z'))
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * List every trash entry, newest first, for a later restore or inspection UI.
 * @param home - the resolved DSH home directory.
 * @returns the entries with their recorded id and removal time.
 */
export async function listTrash(home) {
  const root = trashRoot(home)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    let manifest
    try {
      manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
    } catch {
      manifest = undefined
    }
    result.push({
      entry: path,
      name: entry.name,
      id: typeof manifest?.id === 'string' ? manifest.id : undefined,
      reason: typeof manifest?.reason === 'string' ? manifest.reason : undefined,
      removedAt: await entryRemovalTime(path, entry.name),
    })
  }
  result.sort((a, b) => (b.removedAt ?? 0) - (a.removedAt ?? 0))
  return result
}

/**
 * Move a trashed session directory back into the sessions root.
 * @param entry - the trash entry directory.
 * @param destination - the absolute session directory to restore into.
 * @returns after the move completes.
 */
export async function restoreTrashEntry(entry, destination) {
  await mkdir(join(destination, '..'), { recursive: true })
  await rename(join(entry, 'session'), destination)
  await rm(entry, { recursive: true, force: true })
}
