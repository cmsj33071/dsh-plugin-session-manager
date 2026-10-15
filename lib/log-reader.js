/**
 * Session log reading for export.
 *
 * Two readers exist on purpose. The authoritative one goes through the
 * persistence read handle, which is the only path that transparently handles
 * compression, released format generations, and migration — it yields the
 * current logical event stream, already validated. The fallback one walks the
 * artifact's Zstandard frames directly: it works even when the handle refuses
 * to open a released generation, it never mutates the source (only a write
 * handle publishes a successor), and it makes byte-level recovery of an
 * unreadable-but-intact file possible.
 *
 * @module dsh-plugin-session-manager/log-reader
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Canonical log filename pattern; `session.jsonl` is the released v0 name. */
const LOG_FILENAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/u

/** Little-endian reading of the Zstandard frame magic `28 b5 2f fd`. */
const ZSTD_MAGIC = 0xfd2fb528

/** The persistence seam reports a missing session with this error name. */
const NOT_FOUND = 'SessionPersistenceNotFoundError'

/**
 * Whether an error means "this session has no stored artifact".
 * @param error - any thrown value.
 * @returns true when the session is simply absent.
 */
export function isSessionNotFound(error) {
  return error instanceof Error && error.name === NOT_FOUND
}

/**
 * Canonically serialize a session log: one header line, then one line per
 * event. The shape matches the built-in session-log export, so archives from
 * either producer stay comparable.
 * @param header - the session's immutable header.
 * @param events - the committed events in seq order.
 * @returns the canonical JSONL text.
 */
export function serializeSessionLog(header, events) {
  const lines = [JSON.stringify(header)]
  for (const event of events) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

/**
 * Read one session's current logical log through a persistence read handle.
 * @param persistence - the mounted persistence backend.
 * @param id - the session to read.
 * @param signal - optional cancellation forwarded to open and read.
 * @returns the canonical JSONL text, or undefined when the session is absent.
 */
export async function readSessionLogText(persistence, id, signal) {
  const options = signal === undefined ? {} : { signal }
  let handle
  try {
    handle = await persistence.open(id, 'read', options)
  } catch (error) {
    if (isSessionNotFound(error)) return undefined
    throw error
  }
  try {
    const { events } = await handle.read(0, undefined, options)
    return serializeSessionLog(handle.header, events)
  } finally {
    await handle.close()
  }
}

/**
 * Choose the highest canonical generation file inside one session directory.
 *
 * A compressed and a plain artifact may coexist for the same generation; the
 * compressed one wins, matching the backend's own default.
 * @param dir - the session's directory.
 * @returns the selected file name and version, or undefined when none exists.
 */
async function selectGeneration(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return undefined
  }
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
 * Walk the complete Zstandard frames in one artifact without decompressing
 * their blocks.
 *
 * Frame lengths cannot be recovered from Node's decompressor (it consumes a
 * whole buffer and reports no boundary), so the frame header and block headers
 * are parsed directly. A structurally invalid complete frame throws; a
 * truncated final frame is reported instead, because a torn tail is exactly
 * what crash recovery has to cope with.
 * @param buffer - the complete artifact bytes.
 * @returns the complete frame ranges plus the start of a torn final frame.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * Split one text body into non-empty lines, counting the lines that are not
 * valid JSON so an export can report an unusable tail instead of dropping it
 * silently.
 * @param text - the decompressed log text.
 * @returns the parsed lines and the unusable count.
 */
export function parseLogLines(text) {
  const lines = []
  let unparsedLines = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      lines.push(JSON.parse(line))
    } catch {
      unparsedLines += 1
    }
  }
  return { lines, unparsedLines }
}

/**
 * Read one session's stored log straight from its artifact file.
 *
 * Every frame before a torn tail is decoded, so a session killed mid-flush
 * still exports everything that reached the disk.
 * @param dir - the session's directory.
 * @param signal - optional cancellation checked between steps.
 * @returns the file name, text, and integrity counters, or undefined when the
 *   directory holds no generation.
 */
export async function readRawSessionLogText(dir, signal) {
  const selected = await selectGeneration(dir)
  if (selected === undefined) return undefined
  signal?.throwIfAborted()
  const bytes = await readFile(join(dir, selected.name))
  signal?.throwIfAborted()
  if (!selected.compressed) {
    const { unparsedLines } = parseLogLines(bytes.toString('utf8'))
    return { fileName: selected.name, text: bytes.toString('utf8'), unparsedLines, tornBytes: 0 }
  }
  const { frames, tornStart } = scanZstdFrames(bytes)
  const parts = []
  for (const frame of frames) {
    parts.push(zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8'))
  }
  const text = parts.join('')
  const { unparsedLines } = parseLogLines(text)
  return {
    fileName: selected.name,
    text,
    unparsedLines,
    tornBytes: tornStart === undefined ? 0 : bytes.length - tornStart,
  }
}

/**
 * Measure one session directory without opening its log body.
 * @param dir - the session's directory.
 * @returns the byte total, newest modification time, and file count.
 */
export async function statSessionDir(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { bytes: 0, updatedAt: undefined, files: 0 }
  }
  let bytes = 0
  let updatedAt
  let files = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      const info = await stat(join(dir, entry.name))
      bytes += info.size
      files += 1
      if (updatedAt === undefined || info.mtimeMs > updatedAt) updatedAt = info.mtimeMs
    } catch {
      // A file that vanished between readdir and stat contributes nothing.
    }
  }
  return { bytes, updatedAt, files }
}
