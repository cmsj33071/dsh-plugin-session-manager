/**
 * Host-half type surface for `dsh-plugin-session-manager`.
 *
 * The manifest's `types` and `exports["."].types` point here, so this file must
 * stay in step with `lib/index.js`: every exported value there is declared
 * here. It intentionally imports nothing, because a profile resolves only the
 * packages this plugin declares as dependencies.
 */

/** Plugin name used for effect labels and diagnostics. */
export declare const name: 'session-manager'

/** Services the host half needs before it activates. */
export declare const inject: readonly ['commands', 'connection', 'sessions', 'sessionPersistence']

/** Absolute registration path prefix for the inventory routes. */
export declare const SESSION_MANAGER_ROUTE_PREFIX: '/api/session-manager'

/** Resolved plugin configuration. */
export interface SessionManagerConfig {
  /** Explicit DSH home; wins over `$DSH_HOME` and over `~/.dsh`. */
  home?: string
  /** Stored sessions root; defaults to `<dsh home>/sessions`. */
  sessionsRoot?: string
  /** Derived-state root holding the projection cache; defaults to `<dsh home>/storages`. */
  storagesRoot?: string
  /** Delete a removed session's derived projection-cache record as well. */
  clearProjectionCache?: boolean
  /** Days a trashed session is kept before pruning; 0 disables pruning. */
  trashRetentionDays?: number
  /** Whether to maintain the plugin's session ownership index. */
  trackOwnership?: boolean
  /** Whether a live session may be deleted after being stopped. */
  allowForceRemoveLive?: boolean
  /** How long to wait for a live session's agent to go idle before refusing. */
  stopTimeoutMs?: number
  /** Maximum sessions returned in one listing. */
  listLimit?: number
}

/** Configuration defaults, applied in code rather than by a schema library. */
export declare const CONFIG_DEFAULTS: SessionManagerConfig

/**
 * Merge caller configuration over the defaults, ignoring values of the wrong
 * primitive type.
 * @param config - the raw plugin configuration.
 * @returns the resolved configuration.
 */
export declare function resolveConfig(config?: SessionManagerConfig): SessionManagerConfig

/**
 * Resolve the DSH home directory: explicit config, then a non-blank
 * `$DSH_HOME`, then `~/.dsh`.
 * @param ctx - the host context, for a home provided by another plugin.
 * @param config - the resolved plugin configuration.
 * @returns the absolute home directory and which rule produced it.
 */
export declare function resolveHome(
  ctx: { get?: (name: string) => unknown } | undefined,
  config?: SessionManagerConfig,
): { home: string | undefined; source: string }

/**
 * Register the session manager's routes and command.
 * @param ctx - the host context.
 * @param config - the raw plugin configuration.
 */
export declare function apply(ctx: unknown, config?: SessionManagerConfig): void

/** Session-management service shared by the HTTP routes and host callers. */
export declare class SessionManager {
  constructor(options: Record<string, unknown>)
  /** The sessions root in use. */
  readonly root: string
  /** List every known session with the metadata the management UI shows. */
  list(options?: { workspace?: string; signal?: AbortSignal }): Promise<unknown>
  /** Describe one session and the directories a deletion would remove. */
  plan(id: string): Promise<unknown>
  /** Execute a deletion previously described by {@link SessionManager.plan}. */
  remove(request: { id: string; token: string; force?: boolean; reason?: string }): Promise<unknown>
  /** Export sessions as canonical JSONL into a destination directory. */
  export(request: { ids: readonly string[]; includeDescendants?: boolean; destination?: string; label?: string }): Promise<unknown>
  /** Trash entries, newest first. */
  trash(): Promise<unknown>
  /** Prune trash entries past the retention window. */
  prune(): Promise<unknown>
  /** Total bytes held by the sessions root, for a storage summary. */
  storageSummary(): Promise<unknown>
}
