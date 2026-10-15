/**
 * Session directory discovery.
 *
 * The persistence seam exposes no delete or retention interface, so a deletion
 * has to act on the stored artifacts directly. This module is the only place
 * that reasons about the on-disk layout, and it derives every session id from
 * the stored header rather than from a directory name, because the backend's
 * escaping is injective but not reversible.
 *
 * @module dsh-plugin-session-manager/session-tree
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { parseLogLines, scanZstdFrames } from './log-reader.js'

/** Log filename pattern inside one session directory. */
const LOG_FILENAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/u

/**
 * The directory holding every session artifact for one DSH home.
 * @param home - the resolved DSH home directory.
 * @returns the absolute sessions root.
 */
export function sessionsRoot(home) {
  return join(home, 'sessions')
}

/**
 * Read only the header line of one log artifact, decompressing just the first
 * Zstandard frame. Listing must stay cheap: a session's events are never read
 * to discover its identity.
 * @param path - absolute log path.
 * @param compressed - whether the artifact is Zstandard-compressed.
 * @returns the parsed header object, or undefined when it cannot be read.
 */
async function readHeaderLine(path, compressed) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch {
    return undefined
  }
  try {
    if (!compressed) {
      const first = bytes.toString('utf8').split('\n', 1)[0]
      return JSON.parse(first)
    }
    const { frames } = scanZstdFrames(bytes)
    if (frames.length === 0) return undefined
    const first = zstdDecompressSync(bytes.subarray(frames[0].start, frames[0].end)).toString('utf8')
    const { lines } = parseLogLines(first)
    return lines[0]
  } catch {
    return undefined
  }
}

/**
 * Pick the highest canonical generation file in one session directory.
 * @param names - the directory's entry names.
 * @returns the file name and whether it is compressed, or undefined.
 */
function pickGeneration(names) {
  let best
  for (const name of names) {
    const match = LOG_FILENAME.exec(name)
    if (match === null) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    const compressed = match[2] === '.zstd'
    if (best === undefined || version > best.version || (version === best.version && compressed)) {
      best = { name, version, compressed }
    }
  }
  return best
}

/**
 * Walk one sessions root and identify every stored session.
 *
 * A directory whose header cannot be read is reported as `unreadable` instead
 * of being skipped, so the UI can show it and refuse to delete it rather than
 * quietly hiding storage the user may want to reclaim.
 * @param root - the sessions root.
 * @param signal - optional cancellation checked between directories.
 * @returns one record per session directory.
 */
export async function scanSessionDirectories(root, signal) {
  const records = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return records
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    signal?.throwIfAborted()
    const projectDir = join(root, project.name)
    let sessions
    try {
      sessions = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      signal?.throwIfAborted()
      const dir = join(projectDir, session.name)
      let names
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      const generation = pickGeneration(names)
      if (generation === undefined) {
        records.push({
          directory: dir,
          directoryName: session.name,
          project: project.name,
          id: undefined,
          unreadable: 'no session log in directory',
        })
        continue
      }
      const header = await readHeaderLine(join(dir, generation.name), generation.compressed)
      if (header === undefined || typeof header.id !== 'string') {
        records.push({
          directory: dir,
          directoryName: session.name,
          project: project.name,
          id: undefined,
          unreadable: 'unreadable session header',
        })
        continue
      }
      records.push({
        directory: dir,
        directoryName: session.name,
        project: project.name,
        id: header.id,
        logFile: generation.name,
        header,
      })
    }
  }
  return records
}

/**
 * Index session records by id. Duplicate ids cannot occur for host-minted
 * sessions, and a later duplicate would only replace an identical record.
 * @param records - the records from {@link scanSessionDirectories}.
 * @returns the record map keyed by session id.
 */
export function indexById(records) {
  const byId = new Map()
  for (const record of records) {
    if (record.id === undefined) continue
    byId.set(record.id, record)
  }
  return byId
}

/**
 * Build the descendant closure of one root session from stored headers.
 *
 * Only the parent link is trusted for lineage, because a fork records its own
 * parent and never counts as a descendant of the session it copied. The
 * closure is transitive, so a deletion never orphans a grandchild.
 * @param byId - every known session keyed by id.
 * @param rootId - the session whose descendants are collected.
 * @returns the descendant ids in breadth-first order, excluding the root.
 */
export function descendantIds(byId, rootId) {
  const children = new Map()
  for (const [id, record] of byId) {
    const parent = record.header?.parentSession
    if (typeof parent !== 'string') continue
    const bucket = children.get(parent)
    if (bucket === undefined) children.set(parent, [id])
    else bucket.push(id)
  }
  const collected = []
  const seen = new Set([rootId])
  const queue = [...(children.get(rootId) ?? [])]
  while (queue.length > 0) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    collected.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return collected
}
