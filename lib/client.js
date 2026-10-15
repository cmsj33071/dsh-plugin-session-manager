window.__ModuleLoader__.load({
	id: "dsh-plugin-session-manager",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

		// Only platform seed modules may be required by name. Everything this
		// plugin owns lives inside this one factory, because the client module
		// system materializes exactly one module node per plugin: a sibling file
		// such as `client/state.js` is never registered as a factory, so requiring
		// it by package-relative id fails the whole entry with "missed the module
		// table" and the shell reports "1 entry did not activate".
		const react = require("react")
		const react_jsx_runtime = require("react/jsx-runtime")
		const _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store")
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives")

		/** Locale namespace owned by this plugin's browser feedback. */
		const NS = "session-manager"

		/** The document-relative route prefix, resolved against the document base. */
		const ROUTE_PREFIX = "api/session-manager"

		/** Simplified-Chinese copy. */
		const zh = {
			"menu.group": "会话管理",
			"menu.downloadZip": "下载备份（ZIP）",
			"menu.exportToHome": "备份到 DSH 目录",
			"menu.archive": "归档（可恢复）",
			"menu.remove": "彻底删除…",
			"menu.failed": "操作未完成",
			"dialog.removeTitle": "彻底删除会话",
			"dialog.removeDescription":
				"即将移出「{title}」及其子会话。会话目录会先移入回收站，仍可从备份恢复。",
			"dialog.counts": "{sessions} 个会话目录，含 {descendants} 个子会话",
			"dialog.size": "约 {size}",
			"dialog.blockedTitle": "需要确认的风险",
			"dialog.blockedHint": "仍可继续：这些会话可能正在运行，或有无法一并清理的衍生状态。",
			"dialog.blocked.live": "该会话仍是活动实例，继续前会先请求它停止。",
			"dialog.blocked.writerHeld": "另一个进程正持有该会话的写句柄，删除会导致它的日志损坏。",
			"dialog.blocked.descendantOutsidePlan": "存在未被纳入本次删除的子会话，继续会产生失去父级的孤儿会话。",
			"dialog.blocked.parentMissing": "该会话记录的父会话不可见，血缘链不完整。",
			"dialog.blocked.unindexed": "该会话存在于存储后端，但磁盘上没有可定位的目录。",
			"dialog.confirmRemove": "移入回收站",
			"dialog.forceRemove": "已了解风险，继续",
			"dialog.cancel": "取消",
		}

		/** English copy. */
		const en = {
			"menu.group": "Session management",
			"menu.downloadZip": "Download backup (ZIP)",
			"menu.exportToHome": "Back up into the DSH directory",
			"menu.archive": "Archive (reversible)",
			"menu.remove": "Delete permanently…",
			"menu.failed": "The action did not complete",
			"dialog.removeTitle": "Delete session permanently",
			"dialog.removeDescription":
				'This moves "{title}" and its sub-sessions out of the store. The directories go to trash first and can still be restored from a backup.',
			"dialog.counts": "{sessions} session director(ies), including {descendants} sub-session(s)",
			"dialog.size": "about {size}",
			"dialog.blockedTitle": "Risks to acknowledge",
			"dialog.blockedHint":
				"Continuing is still possible: these sessions may be running, or carry derived state that cannot be cleaned up with them.",
			"dialog.blocked.live": "This session is still a live instance; continuing asks it to stop first.",
			"dialog.blocked.writerHeld":
				"Another process holds this session's write handle; deleting would corrupt its log.",
			"dialog.blocked.descendantOutsidePlan":
				"A sub-session was left outside this deletion, which would orphan it from its parent.",
			"dialog.blocked.parentMissing":
				"This session records a parent that is not visible, so the lineage chain is incomplete.",
			"dialog.blocked.unindexed":
				"The storage backend knows this session but no directory can be located for it.",
			"dialog.confirmRemove": "Move to trash",
			"dialog.forceRemove": "Continue with the risks",
			"dialog.cancel": "Cancel",
		}

		/** Services the browser half needs. Only services it actually reads may be listed: a name that never appears parks the whole plugin, and the entry then never contributes any UI. */
		const inject = ["slots", "locale", "workspaces"]

		//#region state
		/** Initial store state: nothing in flight, nothing pending. */
		const INITIAL_STATE = { bySession: {}, confirm: null }

		/**
		 * Read a response body as JSON, keeping the route's own error code.
		 * @param response - the fetch response.
		 * @returns the parsed body.
		 */
		async function readJson(response) {
			const text = await response.text()
			if (text === "") return { ok: response.ok }
			try {
				return JSON.parse(text)
			} catch {
				return { ok: false, code: "session-manager/bad-response", message: `HTTP ${response.status}` }
			}
		}

		/**
		 * A readable message from an unknown thrown value.
		 * @param error - the thrown value.
		 * @returns the message text.
		 */
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error)
		}

		/**
		 * Whether an archive failure means running work must be stopped first.
		 * @param error - the thrown value from the workspace service.
		 * @returns true when the refusal is an activity refusal.
		 */
		function activeSessionRefusal(error) {
			const code = error?.rpcError?.code ?? error?.code
			return code === "workspace/session-active"
		}

		/**
		 * Call one host route, normalizing transport failures the same way the
		 * route's own errors are normalized.
		 * @param path - the route path below the prefix.
		 * @param init - fetch options.
		 * @returns the parsed body.
		 */
		async function call(path, init) {
			try {
				const response = await fetch(`${ROUTE_PREFIX}${path}`, {
					headers: { "content-type": "application/json" },
					...init,
				})
				return await readJson(response)
			} catch (error) {
				return { ok: false, code: "session-manager/transport", message: messageOf(error) }
			}
		}

		/** Coordinates session operations and the confirmation dialog. */
		class SessionManagerController {
			/** Snapshot store shared by the row menu and the overlay dialog. */
			store = _deepseek_ai_dsh_client_store.createSnapshotStore(INITIAL_STATE)

			/**
			 * Publish one session's operation status, preserving other entries.
			 * @param sessionId - the session the status belongs to.
			 * @param entry - the new status entry.
			 */
			publish(sessionId, entry) {
				this.store.update((state) => {
					state.bySession = { ...state.bySession, [String(sessionId)]: entry }
				})
			}

			/**
			 * Ask the host what deleting a session would remove and open the
			 * confirmation dialog with that plan.
			 *
			 * The host's token is the only thing a later removal accepts, so the
			 * dialog always shows the tree the user is about to lose rather than an
			 * assumption about it.
			 * @param sessionId - the session to remove.
			 * @param displayTitle - the row title, for the dialog copy.
			 * @returns the outcome, for the menu's inline status.
			 */
			async requestRemove(sessionId, displayTitle) {
				this.publish(sessionId, { status: "planning", error: null })
				const plan = await call("/plan", { method: "POST", body: JSON.stringify({ id: sessionId }) })
				if (plan.ok !== true) {
					const message = plan.message ?? plan.code ?? "preview failed"
					this.publish(sessionId, { status: "error", error: message })
					return { ok: false, message }
				}
				this.publish(sessionId, { status: "idle", error: null })
				this.store.update((state) => {
					state.confirm = { sessionId, displayTitle, plan }
				})
				return { ok: true }
			}

			/** Close the confirmation dialog without acting. */
			dismissConfirm() {
				this.store.update((state) => {
					state.confirm = null
				})
			}

			/**
			 * Execute the confirmed removal.
			 * @param options - whether to proceed past the host's blocking reasons.
			 * @returns the host result.
			 */
			async confirmRemove(options = {}) {
				const confirm = this.store.getSnapshot().confirm
				if (confirm === null || confirm === undefined) {
					return { ok: false, code: "session-manager/no-confirmation" }
				}
				const { sessionId, plan } = confirm
				this.publish(sessionId, { status: "removing", error: null })
				const result = await call("/remove", {
					method: "POST",
					body: JSON.stringify({ id: sessionId, token: plan.token, force: options.force === true }),
				})
				if (result.ok === true) {
					this.publish(sessionId, { status: "removed", error: null })
					this.dismissConfirm()
					return result
				}
				this.publish(sessionId, { status: "error", error: result.message ?? result.code ?? "removal failed" })
				// A refused attempt can carry fresh blocking reasons; keep the dialog
				// open with them so the user sees why nothing moved.
				if (result.blocked !== undefined) {
					this.store.update((state) => {
						if (state.confirm?.sessionId !== sessionId) return
						state.confirm = {
							...state.confirm,
							plan: { ...state.confirm.plan, blocked: result.blocked },
						}
					})
				}
				return result
			}

			/**
			 * Ask the host for the current inventory.
			 * @returns the listing body.
			 */
			async list() {
				return call("", { method: "GET" })
			}

			/**
			 * Hand a Host download route to the browser download manager.
			 *
			 * The bare session export route belongs to the shipped log-export
			 * plugin and already streams a ZIP holding the session, its
			 * descendants, and every referenced attachment, so it is reused
			 * rather than reimplemented here.
			 * @param url - the document-relative route.
			 * @param filename - the browser download filename.
			 */
			browserDownload(url, filename) {
				const anchor = document.createElement("a")
				anchor.href = url
				anchor.download = filename
				anchor.click()
			}

			/**
			 * Trigger the shipped ZIP export for one session.
			 * @param sessionId - the session to export.
			 * @returns the outcome, for the UI to report.
			 */
			async downloadZip(sessionId) {
				const route = `api/session.export?${new URLSearchParams({
					sessionId: String(sessionId),
					includeDescendants: "true",
				}).toString()}`
				try {
					const probe = await fetch(route, { method: "HEAD" })
					if (!probe.ok) return { ok: false, message: `export unavailable: HTTP ${probe.status}` }
				} catch (error) {
					return { ok: false, message: messageOf(error) }
				}
				this.browserDownload(route, `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/gu, "_")}.zip`)
				return { ok: true }
			}

			/**
			 * Write a backup through the plugin's own host route, which lands
			 * canonical JSONL under the DSH home instead of the browser's
			 * download directory.
			 * @param sessionId - the session to back up.
			 * @returns the host result.
			 */
			async exportToHome(sessionId) {
				this.publish(sessionId, { status: "exporting", error: null })
				const result = await call("/export", {
					method: "POST",
					body: JSON.stringify({ ids: [sessionId], includeDescendants: true, label: "single" }),
				})
				this.publish(sessionId, {
					status: result.ok === true ? "exported" : "error",
					error: result.ok === true ? null : (result.message ?? result.code ?? "export failed"),
					destination: result.destination,
				})
				return result
			}

			/**
			 * Archive one session through the workspace service, the only
			 * supported way to take a session out of the listings without
			 * destroying its artifact.
			 * @param workspaces - the client workspace service.
			 * @param sessionId - the session to archive.
			 * @param stopActivity - whether to stop running work as part of archiving.
			 * @returns the outcome, including whether stopping was required.
			 */
			async archive(workspaces, sessionId, stopActivity = false) {
				this.publish(sessionId, { status: "archiving", error: null })
				try {
					await workspaces.archiveSession(sessionId, stopActivity ? { stopActivity: true } : undefined)
					this.publish(sessionId, { status: "archived", error: null })
					return { ok: true }
				} catch (error) {
					const needsStop = activeSessionRefusal(error)
					this.publish(sessionId, { status: "error", error: messageOf(error), needsStop })
					return { ok: false, message: messageOf(error), needsStop }
				}
			}
		}
		//#endregion

		//#region styles
		/**
		 * Inject one stylesheet once per document.
		 * @param tagId - the stable tag identity for this stylesheet.
		 * @param css - the stylesheet text.
		 */
		function mountStyles(tagId, css) {
			if (typeof document === "undefined") return
			const selector = `style[data-plugin-css=${JSON.stringify(tagId)}]`
			if (document.querySelector(selector) !== null) return
			const tag = document.createElement("style")
			tag.dataset.plugin = "dsh-plugin-session-manager"
			tag.dataset.pluginCss = tagId
			tag.textContent = css
			document.head.appendChild(tag)
		}

		const DIALOG_CSS = [
			".sessionManagerDialogBody{display:flex;flex-direction:column;gap:10px}",
			".sessionManagerCounts{display:flex;gap:16px;margin:0;color:var(--dsw-alias-label-secondary);font-size:13px}",
			".sessionManagerBlocked{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-error-subtle,rgba(255,80,80,.08))}",
			".sessionManagerBlockedHead{display:flex;gap:6px;align-items:center;font-size:13px}",
			".sessionManagerBlocked ul{margin:0;padding-left:18px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".sessionManagerFooter{display:flex;gap:8px;justify-content:flex-end}",
			".sessionManagerDanger{color:var(--dsw-alias-label-error,#e5484d)}",
			".sessionManagerDialogError{margin:0;font-size:12px;color:var(--dsw-alias-label-error,#e5484d);word-break:break-word}",
		].join("")

		const MENU_CSS =
			".sessionManagerMenuNote{padding:4px 10px 6px;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:260px;white-space:normal}"
		//#endregion

		//#region dialog
		/**
		 * Format a byte count for display.
		 * @param bytes - the byte total.
		 * @returns a short human-readable size.
		 */
		function sizeText(bytes) {
			if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "-"
			const units = ["B", "KiB", "MiB", "GiB"]
			let value = bytes
			let unit = 0
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024
				unit += 1
			}
			return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
		}

		/**
		 * Describe one blocking reason in the user's language.
		 * @param blocked - one blocking entry from the host plan.
		 * @param t - the locale lookup.
		 * @returns the message text.
		 */
		function blockedText(blocked, t) {
			switch (blocked.reason) {
				case "live":
					return t("dialog.blocked.live")
				case "writer-held":
					return t("dialog.blocked.writerHeld")
				case "descendant-outside-plan":
					return t("dialog.blocked.descendantOutsidePlan")
				case "parent-missing":
					return t("dialog.blocked.parentMissing")
				case "unindexed-session":
					return t("dialog.blocked.unindexed")
				default:
					return String(blocked.reason)
			}
		}

		/**
		 * The shared confirmation dialog.
		 *
		 * Nothing is rendered until a confirmation is pending, so the overlay
		 * layer stays empty in normal use.
		 * @param props - the pending request, actions, and localized copy.
		 * @returns the dialog, or null.
		 */
		function SessionManagerDialog(props) {
			const { useSessionManager, confirmRemove, dismissConfirm, t } = props
			// Both hook calls happen on every render, before any early return.
			// A conditional hook changes the hook count between the render that had
			// no pending confirmation and the one that has one, which React rejects
			// with "Rendered more hooks than during the previous render" — the
			// dialog would never appear at all.
			const confirm = useSessionManager((state) => state.confirm)
			const confirmedSessionId = confirm === null || confirm === undefined ? null : String(confirm.sessionId)
			const status = useSessionManager((state) =>
				confirmedSessionId === null ? undefined : state.bySession[confirmedSessionId],
			)
			if (confirm === null || confirm === undefined) return null
			const plan = confirm.plan
			const entries = Array.isArray(plan.entries) ? plan.entries : []
			const blocked = Array.isArray(plan.blocked) ? plan.blocked : []
			const descendantCount = Array.isArray(plan.descendants) ? plan.descendants.length : 0
			const force = blocked.length > 0

			return react_jsx_runtime.jsxs(primitives.Modal, {
				open: true,
				onClose: () => dismissConfirm(),
				title: t("dialog.removeTitle"),
				closeLabel: t("dialog.cancel"),
				description: t("dialog.removeDescription", { title: confirm.displayTitle }),
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "sessionManagerDialogBody",
						children: [
							react_jsx_runtime.jsxs("p", {
								className: "sessionManagerCounts",
								children: [
									react_jsx_runtime.jsx("span", {
										children: t("dialog.counts", { sessions: entries.length, descendants: descendantCount }),
									}),
									react_jsx_runtime.jsx("span", { children: t("dialog.size", { size: sizeText(plan.bytes) }) }),
								],
							}),
							force
								? react_jsx_runtime.jsxs("div", {
										className: "sessionManagerBlocked",
										children: [
											react_jsx_runtime.jsxs("div", {
												className: "sessionManagerBlockedHead",
												children: [
													react_jsx_runtime.jsx(primitives.IconWarningOutlineRegular, {}),
													react_jsx_runtime.jsx("span", { children: t("dialog.blockedTitle") }),
												],
											}),
											react_jsx_runtime.jsx("ul", {
												children: blocked.map((item) =>
													react_jsx_runtime.jsx(
														"li",
														{ children: `${item.id}: ${blockedText(item, t)}` },
														`${item.id}:${item.reason}`,
													),
												),
											}),
											react_jsx_runtime.jsx("p", { children: t("dialog.blockedHint") }),
										],
									})
								: null,
							// The last failure is surfaced here as well, so a refused
							// removal explains itself where the user is already looking
							// instead of only behind the row menu.
							status === undefined || status?.error == null
								? null
								: react_jsx_runtime.jsx("p", {
										className: "sessionManagerDialogError",
										children: String(status.error),
									}),
						],
					}),
				],
				footer: react_jsx_runtime.jsxs("div", {
					className: "sessionManagerFooter",
					children: [
						react_jsx_runtime.jsx(primitives.Button, {
							variant: "outline",
							onClick: () => dismissConfirm(),
							children: t("dialog.cancel"),
						}),
						react_jsx_runtime.jsx(primitives.Button, {
							variant: "primary",
							className: "sessionManagerDanger",
							onClick: () => {
								void confirmRemove({ force })
							},
							children: force ? t("dialog.forceRemove") : t("dialog.confirmRemove"),
						}),
					],
				}),
			})
		}
		//#endregion

		//#region row menu
		/**
		 * One session's management entries.
		 *
		 * The component only issues intent: the controller owns the host round
		 * trips and the overlay dialog owns confirmation, which keeps this entry
		 * a pure command list. Every entry mirrors the shipped behaviour of
		 * closing the row menu before running, so the row's own dismiss handling
		 * cannot swallow the feedback.
		 * @param props - the row identity, injected hooks, actions, and copy.
		 * @returns the menu group.
		 */
		function SessionManagerMenuItems(props) {
			const { sessionId, displayTitle, useSessionManager, useMenuOpenState, t } = props
			const status = useSessionManager((state) => state.bySession[String(sessionId)])
			// The hook is a state-tuple factory: it returns `[menuOpen, setMenuOpen]`,
			// exactly as the shipped menu entries consume it. Taking the tuple itself
			// would leave the menu open after a click, because the setter would be the
			// array rather than a function.
			const menuOpenState = useMenuOpenState()
			const setMenuOpen = Array.isArray(menuOpenState) ? menuOpenState[1] : undefined
			const noteState = react.useState(null)
			const note = noteState[0]
			const setNote = noteState[1]
			const busy = status?.status === "planning" || status?.status === "removing" || status?.status === "exporting"

			/**
			 * Close the row menu, then run one action and surface its outcome inline.
			 * @param action - the action to run.
			 */
			const run = (action) => {
				if (typeof setMenuOpen === "function") setMenuOpen(false)
				void Promise.resolve()
					.then(action)
					.then((result) => {
						if (result?.ok === false) setNote(result.message ?? t("menu.failed"))
						else setNote(null)
					})
					.catch((error) => setNote(error instanceof Error ? error.message : String(error)))
			}

			/**
			 * Turn a missing capability into a readable failure.
			 *
			 * An injected action that never arrived would otherwise throw a
			 * TypeError inside the promise chain, which is reported only as a quiet
			 * note. Naming the missing piece makes the same failure actionable.
			 * @param action - the action to call, possibly absent.
			 * @param args - its arguments.
			 * @param label - the action's name, for the message.
			 * @returns the action's result, or a failure describing what is missing.
			 */
			const invoke = (action, args, label) => {
				if (typeof action !== "function") {
					return { ok: false, message: `the host action "${label}" is unavailable` }
				}
				return action(...args)
			}

			return react_jsx_runtime.jsxs(primitives.MenuGroup, {
				label: t("menu.group"),
				children: [
					react_jsx_runtime.jsx(
						primitives.MenuItemButton,
						{
							icon: react_jsx_runtime.jsx(primitives.IconDownloadOutlineRegular, {}),
							disabled: busy,
							onSelect: () => run(() => invoke(props.exportZip, [sessionId], "exportZip")),
							children: t("menu.downloadZip"),
						},
						"download",
					),
					react_jsx_runtime.jsx(
						primitives.MenuItemButton,
						{
							icon: react_jsx_runtime.jsx(primitives.IconFolderOpenRegular, {}),
							disabled: busy,
							onSelect: () => run(() => invoke(props.exportToHome, [sessionId], "exportToHome")),
							children: t("menu.exportToHome"),
						},
						"export",
					),
					react_jsx_runtime.jsx(
						primitives.MenuItemButton,
						{
							icon: react_jsx_runtime.jsx(primitives.IconArchiveOutlineRegular, {}),
							disabled: busy,
							separatorBefore: true,
							onSelect: () => run(() => invoke(props.archiveSession, [sessionId, false], "archiveSession")),
							children: t("menu.archive"),
						},
						"archive",
					),
					react_jsx_runtime.jsx(
						primitives.MenuItemButton,
						{
							icon: react_jsx_runtime.jsx(primitives.IconTrashOutlineRegular, {}),
							disabled: busy,
							danger: true,
							onSelect: () => run(() => invoke(props.requestRemove, [sessionId, displayTitle], "requestRemove")),
							// A failure here must be impossible to miss. Reporting it
							// only as a quiet note under the group is how "the click did
							// nothing" happens: the action runs, fails, and the surface
							// changes too little for the user to notice.
							children: note === null ? t("menu.remove") : `${t("menu.remove")} — ${note}`,
						},
						"remove",
					),
					note === null
						? null
						: react_jsx_runtime.jsx("div", { className: "sessionManagerMenuNote", children: note }, "note"),
				],
			})
		}
		//#endregion

		/**
		 * Re-pull the Session baseline after a session's artifacts are gone.
		 *
		 * The sidebar renders the Session Controller's list snapshot, and the Host
		 * builds that baseline from the persistence backend only when a baseline is
		 * pulled. Removing the stored log therefore leaves a ghost row behind: it
		 * stays in the list, and opening it fails. `refresh()` re-pulls the
		 * baseline, and because it is not part of the curated `sessions` face it is
		 * looked up at call time and its absence is not an error.
		 * @param ctx - the browser context.
		 * @returns whether a refresh ran and settled.
		 */
		async function refreshSessionBaseline(ctx) {
			const sessions = ctx.get("sessions")
			if (typeof sessions?.refresh !== "function") return false
			try {
				await sessions.refresh()
				return true
			} catch {
				// The deletion already happened; a failed list refresh must not turn
				// it into a reported failure.
				return false
			}
		}

		/**
		 * Run one registration step, reporting failure instead of propagating it.
		 *
		 * Every step here is an addition to a surface another plugin owns, and an
		 * addition must never be able to take the shell down with it. A throw from
		 * `apply` propagates into the loader, so a defect in this plugin would cost
		 * the user the whole interface rather than one missing menu. Failures are
		 * logged and the remaining steps still run.
		 * @param label - the step name, for the diagnostic.
		 * @param step - the step to run.
		 * @returns the step's value, or undefined when it threw.
		 */
		function guarded(label, step) {
			try {
				return step()
			} catch (error) {
				console.error(`[session-manager] ${label} failed:`, error)
				return undefined
			}
		}

		/**
		 * Mount the row menu entries and the confirmation dialog.
		 * @param ctx - the browser context carrying slots, locale, and data services.
		 */
		function apply(ctx) {
			guarded("stylesheet mount", () => {
				mountStyles("dsh-plugin-session-manager/Dialog.css", DIALOG_CSS)
				mountStyles("dsh-plugin-session-manager/SessionMenuItems.css", MENU_CSS)
			})

			const controller = new SessionManagerController()
			guarded("controller service", () => ctx.provide("sessionManager", controller))

			guarded("locale dictionaries", () =>
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-manager: browser dictionaries"),
			)

			const actions = {
				exportZip: (sessionId) => controller.downloadZip(sessionId),
				exportToHome: (sessionId) => controller.exportToHome(sessionId),
				archiveSession: (sessionId, stopActivity) => {
					// Resolve the service at call time so one that appears after
					// activation is still used.
					const service = ctx.get("workspaces")
					if (service === undefined) return { ok: false, message: "workspace service unavailable" }
					return controller.archive(service, sessionId, stopActivity)
				},
				requestRemove: (sessionId, displayTitle) => controller.requestRemove(sessionId, displayTitle),
				confirmRemove: async (options) => {
					const result = await controller.confirmRemove(options)
					// The row must disappear together with the artifacts, so the list is
					// re-pulled only after a removal that actually moved something.
					if (result?.ok === true) await refreshSessionBaseline(ctx)
					return result
				},
				dismissConfirm: () => controller.dismissConfirm(),
			}

			// The row menu is a list slot: this adds one group and replaces nothing.
			guarded("row menu registration", () =>
				ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
					ctx.slots.register(
						{
							name: "sidebar.workspaces.session.menu.item",
							id: "session-manager",
							order: 500,
							locale: NS,
							inject: () => ({ hooks: { sessionManager: controller.store }, ...actions }),
						},
						SessionManagerMenuItems,
					),
				),
			)

			// The overlay layer is where every frame-wide dialog lives, so a
			// confirmation raised from the sidebar resolves in the same place as
			// any other modal.
			guarded("overlay registration", () =>
				ctx.slots.inject("shell.overlay", () =>
					ctx.slots.register(
						{
							name: "shell.overlay",
							id: "session-manager-confirm",
							locale: NS,
							inject: () => ({ hooks: { sessionManager: controller.store }, ...actions }),
						},
						SessionManagerDialog,
					),
				),
			)
		}

		exports.apply = apply
		exports.inject = inject
		exports.NS = NS
		return module.exports
	},
})
