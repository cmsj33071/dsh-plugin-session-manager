/**
 * Session management operations: list, inspect, export, and remove.
 *
 * Every operation degrades instead of throwing when an optional service is
 * absent, so a partially composed profile still gets a working subset. The
 * destructive operation is gated three ways — a preview-issued confirmation
 * token, a refusal while a session is live, and a refusal while a descendant
 * exists — and it never unlinks: artifacts move to the plugin's trash first.
 *
 * @module dsh-plugin-session-manager/operations
 */

import { createHash } from 'node:crypto'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readSessionLogText, statSessionDir, isSessionNotFound } from './log-reader.js'
import { forgetOwnership, readOwnership, recordOwnership } from './ownership.js'
import { descendantIds, indexById, scanSessionDirectories, sessionsRoot } from './session-tree.js'
import { listTrash, pruneTrash, trashSessionDirectory } from './trash.js'

/**
 * The stored log generation this build treats as current.
 *
 * It mirrors the persistence seam's format version without importing it: a
 * profile installs only the packages this plugin declares, so no
 * `@deepseek-ai/*` module may be imported at load time and the constant is
 * duplicated on purpose. It is used for exactly one decision — whether a write
 * handle may be opened as a *probe*. The shipped JSONL backend publishes a
 * migrated successor when a historical generation is write-opened, and a
 * preview must never write. A newer, unknown generation is probed normally: the
 * backend refuses it without writing.
 */
const CURRENT_LOG_GENERATION = 4

/** Canonical log filename pattern; `session.jsonl` is the released v0 name. */
const LOG_FILENAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/u

/**
 * The stored format generation of one located artifact.
 * @param fileName - the selected log file name.
 * @returns the generation number, or undefined when it cannot be read.
 */
function logGeneration(fileName) {
  if (typeof fileName !== 'string') return undefined
  const match = LOG_FILENAME.exec(fileName)
  if (match === null) return undefined
  return match[1] === undefined ? 0 : Number(match[1])
}

/**
 * A stable digest for one deletion plan.
 *
 * The token binds to the exact tree and revision set that was previewed: every
 * directory's id, byte size, and stored revision, plus the descendant set. A
 * confirmation therefore cannot be replayed against a tree that gained, lost,
 * or rewrote a session in between.
 * @param entries - the planned ids with their sizes and revisions.
 * @param descendants - the descendant ids the plan covered.
 * @returns a short hex digest.
 */
function planToken(entries, descendants) {
  const material = [
    ...entries.map((entry) => `${entry.id}:${entry.bytes}:${entry.revision ?? '-'}`),
    '--descendants--',
    ...[...descendants].sort(),
  ]
    .sort()
    .join('\n')
  return createHash('sha256').update(material).digest('hex').slice(0, 32)
}

/**
 * Reduce a stored header to the fields the UI needs, so a listing never leaks
 * unrelated header content.
 * @param header - the stored session header.
 * @returns the selected fields.
 */
function summarizeHeader(header) {
  return {
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd ?? null,
    parentSession: header.parentSession ?? null,
    origin: header.origin ?? null,
    agentPreset: header.agentPreset ?? null,
    delegationDepth: header.delegationDepth ?? 0,
    isSeeded: header.isSeeded === true,
    version: header.version,
  }
}

/**
 * Session management service shared by the HTTP routes and any host caller.
 */
export class SessionManager {
  /**
   * @param options - the composed services and resolved configuration.
   */
  constructor({ sessions, agents, sessionPersistence, sessionQuery, home, config, now = Date.now }) {
    this.sessions = sessions
    this.agents = agents
    this.sessionPersistence = sessionPersistence
    this.sessionQuery = sessionQuery
    this.home = home
    this.config = config
    this.now = now
  }

  /**
   * The sessions root in use.
   * @returns the absolute path.
   */
  get root() {
    return this.config.sessionsRoot ?? sessionsRoot(this.home)
  }

  /**
   * Scan the sessions root.
   *
   * Every call re-reads the directory tree on purpose. That tree is owned by
   * the persistence backend, so a session created, deleted, or moved by the host
   * between two calls is invisible to this plugin until it looks again, and
   * reusing a stale result would silently truncate a descendant closure — the
   * one way a deletion can orphan a session. A scan reads each session's header
   * frame only, never its events, so repeating it is cheap and always preferred
   * to reusing it.
   * @param signal - optional cancellation.
   * @returns the directory records.
   */
  async scan(signal) {
    return scanSessionDirectories(this.root, signal)
  }

  /**
   * Whether a session currently has a live in-process instance. A live session
   * owns in-memory state that deleting its files would desynchronize.
   * @param id - the session id.
   * @returns true when the session is live.
   */
  isLive(id) {
    try {
      return this.sessions?.get(id) !== undefined
    } catch {
      return false
    }
  }

  /**
   * Whether another process holds the session's cross-process write lock.
   *
   * The probe takes a write handle and releases it immediately without
   * appending, which is the backend's own arbitration mechanism rather than a
   * guess from file presence, and it is the only reliable signal available: the
   * lease is a kernel object and leaves no file of its own. The error is
   * identified by name so the plugin does not hard-depend on the persistence
   * package's exported error classes.
   *
   * The probe is refused for a historical log generation, because opening a
   * write handle there makes the backend publish a migrated successor — a
   * preview must stay read-only. `remove` re-checks the revision after flushing,
   * so a concurrent writer on such a log is still caught before anything moves.
   * @param id - the session id.
   * @param generation - the located artifact's format generation, when known.
   * @returns the probe outcome and, when it did not come back free, why.
   */
  async writeLockState(id, generation) {
    if (this.sessionPersistence?.open === undefined) return { state: 'unknown', detail: 'no persistence backend' }
    if (generation !== undefined && generation < CURRENT_LOG_GENERATION) {
      return { state: 'not-probed', detail: `historical log generation v${generation} is read-only to this plugin` }
    }
    let handle
    try {
      handle = await this.sessionPersistence.open(id, 'write')
    } catch (error) {
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        return { state: 'held', detail: 'another process holds the session write lock' }
      }
      if (isSessionNotFound(error)) return { state: 'free' }
      return { state: 'unknown', detail: error instanceof Error ? error.message : String(error) }
    }
    try {
      await handle.close()
    } catch {
      // A close failure does not change the answer: the lock was not held.
    }
    return { state: 'free' }
  }

  /**
   * Ask a live session's agent to stop and wait for it to settle.
   *
   * This is the second half of the liveness guard. Deleting an artifact while
   * its in-memory writer is still alive is not merely untidy: the handle keeps
   * its `materialized` flag, so its next append recreates the file with
   * `open(path, 'a')` and writes event lines without the header frame, leaving
   * a log that every later read reports as corrupt. Stopping the agent and
   * waiting for it to go idle is what removes that failure mode.
   *
   * The wait is bounded: if the run does not settle within the configured
   * timeout the deletion is refused rather than proceeding against a session
   * that may still be writing.
   * @param id - the session id.
   * @returns undefined when the session is not running, otherwise a description
   *   of why it could not be stopped.
   */
  async stopLiveSession(id) {
    const agents = this.agents
    if (agents?.get === undefined) {
      return this.isLive(id) ? 'session is live and no agent registry is available to stop it' : undefined
    }
    let agent
    try {
      agent = agents.get(id)
    } catch {
      return undefined
    }
    if (agent === undefined) return undefined
    try {
      if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' })
      if (typeof agent.whenIdle === 'function') {
        const timeout = this.config.stopTimeoutMs ?? 10000
        let timer
        const settled = await Promise.race([
          Promise.resolve(agent.whenIdle()).then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), timeout)
          }),
        ])
        if (timer !== undefined) clearTimeout(timer)
        if (settled !== true) return `session did not go idle within ${timeout} ms`
      }
    } catch (error) {
      return `session stop failed: ${error instanceof Error ? error.message : String(error)}`
    }
    return undefined
  }

  /**
   * The projection-cache file for one session.
   *
   * The cache is derived state, not an authority, and nothing evicts it when a
   * log disappears — so a deletion that skips it leaves a stale record behind
   * indefinitely.
   * @param id - the session id.
   * @returns the absolute cache path.
   */
  projectionCachePath(id) {
    return join(this.config.storagesRoot, 'session_projcache', 'sessions', `${id}.json`)
  }

  /**
   * Delete one session's derived projection-cache record.
   *
   * Failure is reported but never fails the deletion: the cache is rebuilt on
   * demand, and the authoritative log has already been handled.
   * @param id - the session id.
   * @returns true when the record is gone or was never present.
   */
  async dropProjectionCache(id) {
    if (this.config.clearProjectionCache === false) return true
    try {
      await unlink(this.projectionCachePath(id))
      return true
    } catch (error) {
      return error?.code === 'ENOENT'
    }
  }

  /**
   * The backend's revision for one stored session.
   *
   * The revision is derived from the artifact's identity and timestamps rather
   * than its name, so it changes when the log is rewritten even to the same
   * size. It is the strongest available "nothing wrote here" signal and is
   * re-checked immediately before a deletion moves anything.
   * @param id - the session id.
   * @returns the revision as a string, or undefined when unavailable.
   */
  async sessionRevision(id) {
    if (this.sessionPersistence?.stat === undefined) return undefined
    try {
      const snapshot = await this.sessionPersistence.stat(id)
      if (snapshot === undefined || snapshot.revision === undefined) return undefined
      return String(snapshot.revision)
    } catch {
      return undefined
    }
  }

  /**
   * Run the persistence durability barrier for one session.
   *
   * A live session batches its writes on a short timer, so a deletion that
   * follows an immediate stop can still race the final drain. Flushing makes
   * the committed prefix durable and gives the later revision comparison a
   * stable value to compare against.
   * @param id - the session id.
   * @returns after the barrier, or immediately when the session is not live.
   */
  async flushSession(id) {
    const session = this.sessions?.get?.(id)
    if (session === undefined) return
    try {
      await this.sessions.flush(session)
    } catch {
      // A flush failure is reported through the revision comparison instead.
    }
  }

  /**
   * List every known session with the metadata the management UI shows.
   *
   * Sessions come from two sources that must be merged: the persistence
   * backend knows every stored session including ones whose directory this
   * plugin cannot identify, and the directory scan knows byte sizes and which
   * sessions this plugin owns.
   * @param options - optional workspace filter and cancellation.
   * @returns the sorted listing plus integrity warnings.
   */
  async list({ workspace, signal } = {}) {
    const records = await this.scan(signal)
    const byId = indexById(records)
    const ownership = this.config.trackOwnership
      ? await readOwnership(this.config.ownershipIndexPath)
      : {}
    const warnings = []
    for (const record of records) {
      if (record.unreadable !== undefined) {
        warnings.push({ kind: 'unreadable-directory', directory: record.directory, detail: record.unreadable })
      }
    }

    const snapshots = await this.persistenceSnapshots(signal)
    const items = []
    const seen = new Set()
    for (const snapshot of snapshots) {
      const header = snapshot.header
      if (typeof header?.id !== 'string') continue
      seen.add(header.id)
      const record = byId.get(header.id)
      if (record === undefined) {
        warnings.push({ kind: 'unindexed-session', id: header.id, detail: 'stored session has no identifiable directory' })
      }
      const measured = record === undefined ? { bytes: 0, updatedAt: undefined } : await statSessionDir(record.directory)
      if (workspace !== undefined && (header.cwd ?? null) !== workspace) continue
      items.push({
        ...summarizeHeader(header),
        bytes: snapshot.sizeBytes ?? measured.bytes,
        diskBytes: measured.bytes,
        updatedAt: measured.updatedAt,
        live: this.isLive(header.id),
        hasDirectory: record !== undefined,
        owned: Object.hasOwn(ownership, header.id),
        ownership: ownership[header.id] ?? null,
      })
    }
    // Directory records the persistence backend did not report are still real
    // storage; surfacing them is what lets a user reclaim a leaked directory.
    for (const record of records) {
      if (record.id === undefined || seen.has(record.id)) continue
      const measured = await statSessionDir(record.directory)
      const header = record.header ?? {}
      if (workspace !== undefined && (header.cwd ?? null) !== workspace) continue
      items.push({
        ...summarizeHeader({ id: record.id, ...header }),
        bytes: measured.bytes,
        diskBytes: measured.bytes,
        updatedAt: measured.updatedAt,
        live: this.isLive(record.id),
        hasDirectory: true,
        owned: Object.hasOwn(ownership, record.id),
        ownership: ownership[record.id] ?? null,
        unstored: true,
      })
      warnings.push({ kind: 'unstored-directory', id: record.id, detail: 'directory exists but the backend did not list it' })
    }
    items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    return { root: this.root, items, warnings, generatedAt: this.now() }
  }

  /**
   * Read every stored session snapshot, tolerating a missing backend.
   * @param signal - optional cancellation.
   * @returns the snapshots, or an empty list when persistence is unavailable.
   */
  async persistenceSnapshots(signal) {
    if (this.sessionPersistence === undefined) return []
    try {
      return await this.sessionPersistence.list(signal === undefined ? {} : { signal })
    } catch {
      return []
    }
  }

  /**
   * Describe one session and the exact set of directories a deletion would
   * remove. The returned token is the only thing `remove` accepts.
   * @param id - the root session id.
   * @returns the plan, or a reason it cannot proceed.
   */
  async plan(id) {
    const records = await this.scan()
    const byId = indexById(records)
    const root = byId.get(id)
    if (root === undefined) {
      return { ok: false, code: 'session/not-found', message: `no session directory for "${id}"` }
    }
    const descendantList = descendantIds(byId, id)
    const blocked = []
    // A session the backend lists but the directory scan cannot see means the
    // scan is not observing every stored artifact. When such a session is the
    // target or one of its descendants, the plan cannot be complete and is
    // refused; unrelated invisible sessions are only reported, because they do
    // not change what this deletion removes.
    const unindexed = []
    for (const snapshot of await this.persistenceSnapshots()) {
      const storedId = snapshot?.header?.id
      if (typeof storedId !== 'string' || byId.has(storedId)) continue
      unindexed.push(storedId)
    }
    for (const storedId of unindexed) {
      if (storedId === id || descendantList.includes(storedId)) {
        blocked.push({ id: storedId, reason: 'unindexed-session', detail: 'stored session has no identifiable directory' })
      }
    }
    if (this.isLive(id)) blocked.push({ id, reason: 'live' })
    for (const descendant of descendantList) {
      if (this.isLive(descendant)) blocked.push({ id: descendant, reason: 'live' })
    }
    // A write handle in another process holds a kernel lease on the session
    // directory. Moving it would leave that writer appending to a path that no
    // longer exists, so the plan refuses while the lease is held. Each target is
    // probed once: the probe opens and immediately closes a write handle.
    const probes = new Map()
    for (const target of [id, ...descendantList]) {
      const probe = await this.writeLockState(target, logGeneration(byId.get(target)?.logFile))
      probes.set(target, probe)
      if (probe.state === 'held') blocked.push({ id: target, reason: 'writer-held', detail: probe.detail })
    }
    const entries = []
    for (const target of [id, ...descendantList]) {
      const record = byId.get(target)
      if (record === undefined) continue
      const measured = await statSessionDir(record.directory)
      entries.push({
        id: target,
        directory: record.directory,
        bytes: measured.bytes,
        files: measured.files,
        revision: await this.sessionRevision(target),
        logGeneration: logGeneration(record.logFile),
        lockProbe: probes.get(target)?.state ?? 'unknown',
      })
    }
    // A session whose recorded parent is not visible at all means the store and
    // the directory scan disagree, so the descendant closure cannot be trusted
    // to be complete. Any such session inside the plan's closure blocks it —
    // this is what catches a descendant the scan failed to reach. The target's
    // own parent is irrelevant: it is being removed, not orphaned.
    const closure = new Set([id, ...descendantList])
    for (const candidateId of closure) {
      if (candidateId === id) continue
      const parent = byId.get(candidateId)?.header?.parentSession
      if (typeof parent !== 'string') continue
      if (byId.has(parent)) continue
      blocked.push({ id: candidateId, reason: 'parent-missing', parent })
    }
    // Deleting a parent while a descendant survives creates an orphan whose
    // parent link can never resolve, so a surviving child blocks the plan.
    for (const [candidateId, record] of byId) {
      const parent = record.header?.parentSession
      if (typeof parent !== 'string' || !closure.has(parent)) continue
      if (!closure.has(candidateId)) {
        blocked.push({ id: candidateId, reason: 'descendant-outside-plan', parent })
      }
    }
    return {
      ok: true,
      id,
      header: summarizeHeader(root.header ?? { id }),
      descendants: descendantList,
      entries,
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      token: planToken(entries, descendantList),
      blocked,
      unindexed,
      requiresForce: blocked.length > 0,
    }
  }

  /**
   * Execute a deletion previously described by {@link plan}.
   * @param request - the session id, confirmation token, and force flag.
   * @returns the per-session outcome.
   */
  async remove({ id, token, force = false, reason }) {
    const plan = await this.plan(id)
    if (!plan.ok) return { ok: false, code: plan.code, message: plan.message }
    if (token !== plan.token) {
      return {
        ok: false,
        code: 'session/confirmation-mismatch',
        message: 'the session tree changed since the preview; re-run the preview and confirm again',
      }
    }
    if (plan.blocked.length > 0 && !force) {
      return {
        ok: false,
        code: 'session/blocked',
        message: 'deletion is blocked; re-run with force to proceed',
        blocked: plan.blocked,
      }
    }
    // Liveness is the one blocking reason that can be cleared safely rather
    // than overridden: stopping the agent and waiting for it to go idle is what
    // prevents the deleted log from being recreated without its header frame.
    if (force && plan.blocked.some((item) => item.reason === 'live')) {
      const stopFailures = []
      for (const entry of plan.entries) {
        const failure = await this.stopLiveSession(entry.id)
        if (failure !== undefined) stopFailures.push({ id: entry.id, reason: 'live', detail: failure })
      }
      if (stopFailures.length > 0) {
        return {
          ok: false,
          code: 'session/stop-failed',
          message: 'a live session could not be stopped; refusing to delete its artifacts',
          blocked: stopFailures,
        }
      }
    }
    // A write lock held by another process cannot be cleared from here, and
    // deleting underneath it would desynchronize that writer. The generation the
    // preview recorded is reused, so this second check is the same probe.
    const lockFailures = []
    for (const entry of plan.entries) {
      const held = await this.writeLockState(entry.id, entry.logGeneration)
      if (held.state === 'held') lockFailures.push({ id: entry.id, reason: 'writer-held', detail: held.detail })
    }
    if (lockFailures.length > 0) {
      return {
        ok: false,
        code: 'session/writer-held',
        message: 'another process holds a write handle; refusing to delete its artifacts',
        blocked: lockFailures,
      }
    }
    // Drain any pending write and then confirm nothing was written since the
    // preview. A revision that moved means the plan describes a log that no
    // longer exists in that shape, so the user has to look again.
    const changed = []
    for (const entry of plan.entries) {
      await this.flushSession(entry.id)
      const current = await this.sessionRevision(entry.id)
      if (entry.revision === undefined || current === undefined) continue
      if (current !== entry.revision) changed.push({ id: entry.id, reason: 'revision-changed', was: entry.revision, now: current })
    }
    if (changed.length > 0) {
      return {
        ok: false,
        code: 'session/changed',
        message: 'a session was written after the preview; re-run the preview and confirm again',
        changed,
      }
    }
    const trashed = []
    const failed = []
    // Children are moved first so an interrupted run never leaves a session
    // directory whose recorded descendants have already disappeared.
    const ordered = [...plan.entries].reverse()
    for (const entry of ordered) {
      try {
        const result = await trashSessionDirectory({
          home: this.home,
          directory: entry.directory,
          id: entry.id,
          reason: reason ?? `deleted from session-manager`,
          now: this.now,
        })
        trashed.push({ id: entry.id, entry: result.entry, bytes: entry.bytes })
      } catch (error) {
        failed.push({ id: entry.id, message: error instanceof Error ? error.message : String(error) })
      }
    }
    // Derived state is cleared only for sessions whose artifacts actually moved,
    // so a partial failure never leaves a session with a cache but no log.
    const staleCache = []
    for (const item of trashed) {
      if (!(await this.dropProjectionCache(item.id))) staleCache.push(item.id)
    }
    if (this.config.trackOwnership && trashed.length > 0) {
      try {
        await forgetOwnership(this.config.ownershipIndexPath, trashed.map((item) => item.id))
      } catch {
        // The ownership index is advisory; a failed update must not fail a
        // deletion whose artifacts have already moved.
      }
    }
    return {
      ok: failed.length === 0,
      code: failed.length === 0 ? 'session/removed' : 'session/partially-removed',
      removed: trashed,
      failed,
      staleCache,
      trashRoot: this.config.trashRoot,
    }
  }

  /**
   * Export sessions as canonical JSONL into a destination directory.
   *
   * Each session gets its own directory holding the canonical log plus a
   * metadata file, and a batch gets one index describing every exported
   * session. The log text is read through the persistence handle when possible
   * and otherwise recovered from the artifact's Zstandard frames.
   * @param request - selection, destination, and whether descendants are included.
   * @returns the exported entries and any per-session failures.
   */
  async export({ ids, includeDescendants = true, destination, label = 'backup' }) {
    const records = await this.scan()
    const byId = indexById(records)
    const selected = []
    const seen = new Set()
    const queue = [...ids]
    while (queue.length > 0) {
      const id = queue.shift()
      if (seen.has(id)) continue
      seen.add(id)
      selected.push(id)
      if (includeDescendants) queue.push(...descendantIds(byId, id))
    }
    const target = destination ?? this.defaultExportDirectory(label)
    await mkdir(target, { recursive: true })
    const exported = []
    const failed = []
    for (const id of selected) {
      try {
        const result = await this.exportOne(id, target, byId.get(id))
        if (result.ok) exported.push(result.entry)
        else failed.push({ id, message: result.message })
      } catch (error) {
        failed.push({ id, message: error instanceof Error ? error.message : String(error) })
      }
    }
    const index = {
      version: 1,
      exportedAt: this.now(),
      sessionsRoot: this.root,
      sessions: exported,
      failures: failed,
    }
    await writeFile(join(target, 'index.json'), JSON.stringify(index, null, 2), 'utf8')
    return { ok: failed.length === 0, destination: target, sessions: exported, failures: failed }
  }

  /**
   * The default export directory for one label, under the DSH home so an
   * export never lands inside a workspace by accident.
   * @param label - a short batch label.
   * @returns the absolute directory.
   */
  defaultExportDirectory(label) {
    const safe = label.replace(/[^A-Za-z0-9_-]/gu, '_')
    return join(this.home, 'session-manager', 'exports', `${new Date(this.now()).toISOString().replace(/[:.]/gu, '-')}-${safe}`)
  }

  /**
   * Export exactly one session.
   * @param id - the session id.
   * @param target - the batch destination directory.
   * @param record - the directory record when one was identified.
   * @returns the export entry or a failure message.
   */
  async exportOne(id, target, record) {
    let text
    let source
    if (this.sessionPersistence !== undefined) {
      try {
        text = await readSessionLogText(this.sessionPersistence, id)
        source = 'persistence-handle'
      } catch {
        text = undefined
      }
    }
    let tornBytes = 0
    if (text === undefined) {
      if (record === undefined) return { ok: false, message: 'no session directory and persistence could not read the log' }
      const { readRawSessionLogText } = await import('./log-reader.js')
      const raw = await readRawSessionLogText(record.directory)
      if (raw === undefined) return { ok: false, message: 'no session log artifact' }
      text = raw.text
      tornBytes = raw.tornBytes
      source = `artifact:${raw.fileName}`
    }
    const directory = join(target, 'sessions', id.replace(/[^A-Za-z0-9_-]/gu, '_'))
    await mkdir(dirname(directory), { recursive: true })
    await mkdir(directory, { recursive: true })
    const header = record?.header ?? undefined
    const bytes = Buffer.byteLength(text, 'utf8')
    await writeFile(join(directory, 'session.jsonl'), text, 'utf8')
    await writeFile(
      join(directory, 'meta.json'),
      JSON.stringify({ id, exportedAt: this.now(), source, bytes, tornBytes, header }, null, 2),
      'utf8',
    )
    return { ok: true, entry: { id, directory, bytes, source, tornBytes } }
  }

  /**
   * Record that this plugin created or adopted a session directory.
   * @param id - the session id.
   * @param source - whether the plugin materialized or adopted the session.
   * @returns after the index is updated, or immediately when tracking is off.
   */
  async registerOwned(id, source = 'plugin') {
    if (!this.config.trackOwnership) return
    await recordOwnership(this.config.ownershipIndexPath, id, source, this.now)
  }

  /**
   * Trash entries, newest first.
   * @returns the entries.
   */
  async trash() {
    return listTrash(this.home)
  }

  /**
   * Prune trash entries past the retention window.
   * @returns the removed and failed paths.
   */
  async prune() {
    if (!this.config.trashRetentionDays) return { removed: [], failed: [] }
    return pruneTrash(this.home, this.config.trashRetentionDays, this.now)
  }

  /**
   * Total bytes held by the sessions root, for a storage summary.
   * @returns the byte total and session count.
   */
  async storageSummary() {
    const records = await this.scan()
    let bytes = 0
    let files = 0
    for (const record of records) {
      const measured = await statSessionDir(record.directory)
      bytes += measured.bytes
      files += measured.files
    }
    return { sessions: records.length, bytes, files, root: this.root }
  }
}
