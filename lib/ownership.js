/**
 * Sidecar ownership index for sessions this plugin materialized.
 *
 * The host persistence seam exposes no delete or retention interface — pruning
 * stored sessions is explicitly out of its scope — so an uninstall or a session
 * deletion performed outside this plugin can leave a session directory that
 * nothing claims. This index records which session directories this plugin
 * created, so a later deletion can prove ownership instead of guessing from a
 * name pattern.
 *
 * The index is deliberately fail-soft: a missing, unreadable, or malformed file
 * degrades to "no recorded ownership" rather than throwing, because losing the
 * index must never block listing sessions. Reads never create the file; only a
 * successful registration writes it.
 *
 * @module dsh-plugin-session-manager/ownership
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Current on-disk shape of the ownership index. */
const INDEX_VERSION = 1

/**
 * The path of the ownership index inside one DSH home directory.
 * @param home - the resolved DSH home directory.
 * @returns the absolute index path.
 */
export function ownershipIndexPath(home) {
  return join(home, 'session-manager', 'owned-sessions.json')
}

/**
 * Validate one parsed index document, discarding unknown shapes instead of
 * trusting them. Corruption degrades to an empty index, never a throw.
 * @param value - the parsed JSON document.
 * @returns the validated record map, keyed by session id.
 */
function normalizeIndex(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  if (value.version !== INDEX_VERSION) return {}
  const owned = value.owned
  if (typeof owned !== 'object' || owned === null || Array.isArray(owned)) return {}
  const result = {}
  for (const [id, record] of Object.entries(owned)) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue
    const { createdAt, source } = record
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue
    if (source !== 'plugin' && source !== 'adopted') continue
    result[id] = { createdAt, source }
  }
  return result
}

/**
 * Read the ownership index. A missing file is an empty index, not an error.
 * @param path - absolute index path.
 * @returns the record map keyed by session id.
 */
export async function readOwnership(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    return {}
  }
  try {
    return normalizeIndex(JSON.parse(text))
  } catch {
    return {}
  }
}

/**
 * Replace the ownership index atomically, so a crash mid-write cannot leave a
 * half-written document that a later read would treat as corrupt.
 * @param path - absolute index path.
 * @param owned - the complete record map to persist.
 * @returns after the replacement is durable.
 */
export async function writeOwnership(path, owned) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const document = JSON.stringify({ version: INDEX_VERSION, owned }, null, 2)
  await writeFile(temp, document, 'utf8')
  await rename(temp, path)
}

/**
 * Record one session's ownership, preserving every other entry.
 * @param path - absolute index path.
 * @param id - the session id to record.
 * @param source - whether the plugin materialized or adopted the session.
 * @param now - clock injection for deterministic tests.
 * @returns the updated record map.
 */
export async function recordOwnership(path, id, source, now = Date.now) {
  const owned = await readOwnership(path)
  owned[id] = { createdAt: now(), source }
  await writeOwnership(path, owned)
  return owned
}

/**
 * Drop one session's ownership record. Idempotent, so a retried deletion after
 * the session directory is already gone still settles cleanly.
 * @param path - absolute index path.
 * @param ids - the session ids to forget.
 * @returns the updated record map.
 */
export async function forgetOwnership(path, ids) {
  const owned = await readOwnership(path)
  let changed = false
  for (const id of ids) {
    if (Object.hasOwn(owned, id)) {
      delete owned[id]
      changed = true
    }
  }
  if (changed) await writeOwnership(path, owned)
  return owned
}
