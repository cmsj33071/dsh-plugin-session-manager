/**
 * Host half of the session manager.
 *
 * It owns the session-inventory HTTP routes and the `/sessions` user command.
 * The destructive and export logic lives in `./operations.js`, and the on-disk
 * layout knowledge is confined to `./session-tree.js`, `./log-reader.js`, and
 * `./trash.js`.
 *
 * @module dsh-plugin-session-manager
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { SessionManager } from './operations.js'
import { ownershipIndexPath } from './ownership.js'
import { trashRoot } from './trash.js'

/** Plugin name, used for effect labels and diagnostics. */
export const name = 'session-manager'

/** Services the host half needs before it activates. */
export const inject = ['commands', 'connection', 'sessions', 'sessionPersistence']

/** Absolute registration path prefix for the inventory routes. */
export const SESSION_MANAGER_ROUTE_PREFIX = '/api/session-manager'

/**
 * Written once per activation, next to the plugin's other state.
 *
 * The desktop launcher keeps no run-time log, so a boot that produces no crash
 * file is ambiguous: the plugin may have activated, or it may have been parked
 * because a declared service was missing. This file resolves that from outside
 * the process, and it records what the composition actually offered.
 */
const ACTIVATION_MARKER = 'active.json'

/**
 * Write the activation marker, tolerating every failure: the marker is a
 * diagnostic, and a diagnostic must never be able to break activation.
 * @param path - the absolute marker path.
 * @param payload - what activation observed.
 * @returns true when the marker was written.
 */
async function writeActivationMarker(path, payload) {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Configuration defaults.
 *
 * This is a plain object rather than a schema built by a validation library on
 * purpose. A profile installs a plugin's `dependencies` into the profile's own
 * store, which does not necessarily resolve the harness's internal package
 * names; a top-level import of one would therefore fail the whole module at load
 * time and keep the plugin out of the tree entirely. Every field here is
 * optional, and `resolveConfig` applies the defaults in code, so no validation
 * library is needed.
 */
export const CONFIG_DEFAULTS = {
  /** Explicit DSH home; wins over `$DSH_HOME` and over `~/.dsh`. */
  home: undefined,
  /** Stored sessions root; defaults to `<dsh home>/sessions`. */
  sessionsRoot: undefined,
  /** Derived-state root holding the projection cache; defaults to `<dsh home>/storages`. */
  storagesRoot: undefined,
  /** Delete a removed session's derived projection-cache record as well. */
  clearProjectionCache: true,
  /** Days a trashed session is kept before pruning; 0 disables pruning. */
  trashRetentionDays: 30,
  /** Whether to maintain the plugin's session ownership index. */
  trackOwnership: true,
  /** Whether a live session may be deleted after being stopped. */
  allowForceRemoveLive: true,
  /** How long to wait for a live session's agent to go idle before refusing. */
  stopTimeoutMs: 10000,
  /** Maximum sessions returned in one listing. */
  listLimit: 500,
}

/**
 * Merge caller configuration over the defaults, ignoring anything that is not
 * the expected primitive so a hand-edited profile patch cannot inject a
 * nonsense value.
 * @param config - the raw plugin configuration.
 * @returns the resolved configuration.
 */
export function resolveConfig(config = {}) {
  const resolved = { ...CONFIG_DEFAULTS }
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(CONFIG_DEFAULTS, key) || value === undefined) continue
    const expected = typeof CONFIG_DEFAULTS[key]
    if (CONFIG_DEFAULTS[key] === undefined) {
      if (typeof value === 'string') resolved[key] = value
      continue
    }
    if (typeof value === expected) resolved[key] = value
  }
  return resolved
}

/**
 * Resolve the DSH home directory.
 *
 * The precedence mirrors `@deepseek-ai/dsh-home-paths` (@see resolveDshHome):
 * an explicit configured path, then a non-blank `$DSH_HOME`, then `~/.dsh`. It
 * is reimplemented here rather than imported because the package is a library
 * the harness does not resolve from a profile install, and because there is no
 * `homePaths` cordis service to read instead — a plugin that waits for one
 * never activates, which is exactly the failure this function exists to end.
 *
 * The desktop host process starts without `DSH_HOME` in its environment, so the
 * operating-system home is the branch that actually runs there; it is read
 * through `node:os` so no harness-internal package is needed at load time.
 * @param ctx - the host context, for an explicit home provided by another plugin.
 * @param config - the resolved plugin configuration.
 * @returns the absolute home directory and which rule produced it.
 */
export function resolveHome(ctx, config = {}) {
  const candidates = [
    ['config.home', config.home],
    ['homePaths.dshHome', ctx?.get?.('homePaths')?.dshHome],
    ['homePaths.home', ctx?.get?.('homePaths')?.home],
    ['$DSH_HOME', process.env.DSH_HOME],
  ]
  for (const [source, candidate] of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return { home: resolve(candidate.trim()), source }
    }
  }
  try {
    return { home: join(homedir(), '.dsh'), source: '~/.dsh' }
  } catch {
    return { home: undefined, source: 'unresolved' }
  }
}

/**
 * Read and parse a JSON request body with a hard size ceiling.
 * @param request - the inbound request.
 * @param maxBytes - the largest accepted body.
 * @returns the parsed value.
 */
async function readJsonBody(request, maxBytes = 1 << 20) {
  const text = await request.text()
  if (text.length > maxBytes) throw new Error(`request body exceeds ${maxBytes} bytes`)
  if (text === '') return {}
  return JSON.parse(text)
}

/**
 * One JSON response with no-store caching, matching the sibling export route.
 * @param value - the JSON-serializable body.
 * @param status - the HTTP status.
 * @returns the response.
 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Register the session manager's routes and command.
 * @param ctx - the host context.
 * @param config - the resolved configuration.
 */
export function apply(ctx, config = {}) {
  const configured = resolveConfig(config)
  const { home, source } = resolveHome(ctx, configured)
  if (home === undefined) {
    ctx.logger?.warn?.('session-manager: no DSH home directory resolved; plugin stays idle')
    return
  }
  const resolved = {
    ...configured,
    storagesRoot: configured.storagesRoot ?? join(home, 'storages'),
    trashRoot: trashRoot(home),
    ownershipIndexPath: ownershipIndexPath(home),
    activationPath: join(home, 'session-manager', ACTIVATION_MARKER),
  }
  const manager = new SessionManager({
    sessions: ctx.get('sessions'),
    agents: ctx.get('agents'),
    sessionPersistence: ctx.get('sessionPersistence'),
    sessionQuery: ctx.get('sessionQuery'),
    home,
    config: resolved,
  })
  ctx.provide('sessionManager', manager)

  // Activation is recorded on disk because the desktop launcher keeps no
  // run-time log: a profile that boots with no crash file looks identical
  // whether this plugin activated or was parked on a missing service. This one
  // file makes that question answerable from outside the process, and it is
  // written once, after registration, so it reports what actually happened.
  const activation = {
    activatedAt: new Date(manager.now()).toISOString(),
    activationMarker: ACTIVATION_MARKER,
    home,
    homeSource: source,
    sessionsRoot: manager.root,
    hadPersistence: ctx.get('sessionPersistence') !== undefined,
    hadConnection: ctx.get('connection') !== undefined,
  }

  // Retention is best-effort housekeeping: a failure must not break activation.
  ctx.effect(() => {
    void manager.prune().catch(() => undefined)
  }, 'session-manager: trash retention')

  // Each registration reports its own failure. An addition must never be able to
  // make the plugin look "installed but inactive": a silent throw here is exactly
  // how a user ends up with a menu whose actions do nothing.
  const failures = []
  let routes = 0
  try {
    routes = registerRoutes(ctx, manager, resolved)
  } catch (error) {
    failures.push(`HTTP routes: ${describe(error)}`)
    ctx.logger?.warn?.(`session-manager: HTTP routes were not registered: ${describe(error)}`)
  }
  try {
    registerCommand(ctx, manager)
  } catch (error) {
    failures.push(`/sessions command: ${describe(error)}`)
    ctx.logger?.warn?.(`session-manager: the /sessions command was not registered: ${describe(error)}`)
  }
  void writeActivationMarker(resolved.activationPath, { ...activation, routes, failures }).then(
    (written) => {
      if (!written) ctx.logger?.warn?.('session-manager: could not write the activation marker')
    },
    () => undefined,
  )
}

/**
 * A readable description of an unknown thrown value.
 * @param error - the thrown value.
 * @returns the message text.
 */
function describe(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Register the authenticated inventory routes.
 * @param ctx - the host context.
 * @param manager - the session manager service.
 * @param config - the resolved configuration.
 * @returns how many routes were registered.
 */
function registerRoutes(ctx, manager, config) {
  const connection = ctx.get('connection')
  if (connection?.fetch?.register === undefined) {
    ctx.logger?.warn?.('session-manager: no connection.fetch carrier; HTTP routes are unavailable')
    return 0
  }
  const guard = (handler) => async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      return json({ ok: false, code: 'session-manager/failed', message: error instanceof Error ? error.message : String(error) }, 500)
    }
  }

  let count = 0
  const register = (suffix, methods, handler) => {
    connection.fetch.register({
      path: suffix === '' ? SESSION_MANAGER_ROUTE_PREFIX : `${SESSION_MANAGER_ROUTE_PREFIX}${suffix}`,
      methods,
      requestBody: 'buffered',
      fetch: guard(handler),
    })
    count += 1
  }

  register('', ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const workspace = url.searchParams.get('workspace') ?? undefined
    const listed = await manager.list({ workspace })
    const items = listed.items.slice(0, config.listLimit)
    const summary = await manager.storageSummary()
    const body = { ok: true, ...listed, items, storage: summary, truncated: listed.items.length > items.length }
    if (request.method === 'HEAD') return json(null, 200)
    return json(body)
  })

  register('/plan', ['POST'], async (request) => {
    const body = await readJsonBody(request)
    if (typeof body.id !== 'string' || body.id === '') {
      return json({ ok: false, code: 'session-manager/bad-request', message: 'id is required' }, 400)
    }
    return json(await manager.plan(body.id))
  })

  register('/remove', ['POST'], async (request) => {
    const body = await readJsonBody(request)
    if (typeof body.id !== 'string' || body.id === '') {
      return json({ ok: false, code: 'session-manager/bad-request', message: 'id is required' }, 400)
    }
    if (typeof body.token !== 'string' || body.token === '') {
      return json({ ok: false, code: 'session-manager/bad-request', message: 'a preview token is required' }, 400)
    }
    const force = body.force === true
    if (force && !config.allowForceRemoveLive) {
      return json({ ok: false, code: 'session-manager/force-disabled', message: 'forced removal is disabled by configuration' }, 403)
    }
    const plan = await manager.plan(body.id)
    if (plan.ok && plan.blocked.length > 0 && blockIsOnlyLive(plan.blocked) && !config.allowForceRemoveLive) {
      return json({ ok: false, code: 'session-manager/force-disabled', message: 'forced removal is disabled by configuration' }, 403)
    }
    return json(await manager.remove({ id: body.id, token: body.token, force, reason: body.reason }))
  })

  register('/export', ['POST'], async (request) => {
    const body = await readJsonBody(request)
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id !== '') : []
    if (ids.length === 0) {
      return json({ ok: false, code: 'session-manager/bad-request', message: 'ids must contain at least one session id' }, 400)
    }
    if (body.destination !== undefined && typeof body.destination !== 'string') {
      return json({ ok: false, code: 'session-manager/bad-request', message: 'destination must be a string' }, 400)
    }
    const result = await manager.export({
      ids,
      includeDescendants: body.includeDescendants !== false,
      destination: body.destination,
      label: typeof body.label === 'string' ? body.label : 'backup',
    })
    return json(result)
  })

  register('/trash', ['GET'], async () => json({ ok: true, items: await manager.trash() }))

  register('/trash/prune', ['POST'], async () => json({ ok: true, ...(await manager.prune()) }))
  return count
}

/**
 * Whether every blocking reason is a live session.
 * @param blocked - the blocking reasons from a plan.
 * @returns true when only liveness blocks the plan.
 */
function blockIsOnlyLive(blocked) {
  return blocked.length > 0 && blocked.every((item) => item.reason === 'live')
}

/**
 * Register the `/sessions` user command, which reports the inventory without
 * creating a model turn.
 * @param ctx - the host context.
 * @param manager - the session manager service.
 */
function registerCommand(ctx, manager) {
  const commands = ctx.get('commands')
  if (commands?.register === undefined) return
  const definitionId = 'dsh-plugin-session-manager'
  ctx.effect(
    () =>
      commands.register({
        definitionId,
        name: 'sessions',
        description: 'Report the stored session inventory and trash usage',
        handler: async (invocation) => {
          const argument = invocation.rawInput.trim()
          if (argument !== '') {
            return { kind: 'error', text: '/sessions does not accept arguments; use the session manager panel instead.' }
          }
          const summary = await manager.storageSummary()
          const trash = await manager.trash()
          const megabytes = (summary.bytes / (1024 * 1024)).toFixed(1)
          return {
            kind: 'success',
            text: `${summary.sessions} stored session(s), ${megabytes} MiB across ${summary.files} file(s). ${trash.length} item(s) in trash.`,
          }
        },
      }),
    'session-manager: /sessions command',
  )
}

/** Re-export the service class for host callers and tests. */
export { SessionManager } from './operations.js'


