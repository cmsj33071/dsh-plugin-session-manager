/**
 * Browser-side check for the client bundle.
 *
 * The bundle is loaded exactly as the host loads it — through
 * `window.__ModuleLoader__.load({ id, factory })` with a synchronous `require`
 * for platform modules — so the wrapper format, the module ids, and the
 * dependency names are all exercised rather than assumed. Platform modules and
 * `fetch` are stubbed; nothing here touches a running DSH instance.
 *
 * Run with the bundled Node:
 *   node tests/check-client.mjs
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')

let failures = 0
/** Record one assertion result. */
function check(label, condition, detail = '') {
  if (condition) console.log(`OK    ${label}`)
  else {
    failures += 1
    console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

// --- platform module stubs ---------------------------------------------------
const element = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
const react = {
  useState: (initial) => {
    // State is stored so a later call can observe a write, which is what makes
    // the menu-close assertion meaningful. Hooks are called in a fixed order per
    // render, so one cell per position is enough for a single component.
    react.__hookCalls = (react.__hookCalls ?? 0) + 1
    const cells = (react.__cells ??= [])
    const index = (react.__cellIndex ??= 0)
    react.__cellIndex = index + 1
    if (cells[index] === undefined) cells[index] = { value: typeof initial === 'function' ? initial() : initial }
    return [
      cells[index].value,
      (next) => {
        cells[index].value = next
      },
    ]
  },
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  createElement: element,
  Fragment: Symbol('Fragment'),
  /** Reset the hook cells between component renders. */
  __reset: () => {
    react.__cellIndex = 0
    react.__hookCalls = 0
  },
}
const primitives = {
  Button: 'Button',
  MenuGroup: 'MenuGroup',
  MenuItemButton: 'MenuItemButton',
  Modal: 'Modal',
  IconDownloadOutlineRegular: 'IconDownloadOutlineRegular',
  IconFolderOpenRegular: 'IconFolderOpenRegular',
  IconArchiveOutlineRegular: 'IconArchiveOutlineRegular',
  IconTrashOutlineRegular: 'IconTrashOutlineRegular',
  IconWarningOutlineRegular: 'IconWarningOutlineRegular',
}
const snapshotStore = {
  createSnapshotStore: (initial) => {
    let state = initial
    const listeners = new Set()
    return {
      getSnapshot: () => state,
      update: (mutator) => {
        mutator(state)
        for (const listener of listeners) listener(state)
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
  },
}

const registered = new Map()
const windowStub = {
  __ModuleLoader__: {
    load: (entry) => {
      if (typeof entry?.id !== 'string' || typeof entry?.factory !== 'function') {
        throw new Error('__ModuleLoader__.load requires { id, factory }')
      }
      registered.set(entry.id, entry.factory)
    },
  },
}
const documentStub = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, click: () => {} }),
  head: { appendChild: () => {} },
}

/**
 * The synchronous require the loader hands to a factory.
 *
 * It mirrors the real resolution order so a violation of the one-module rule is
 * reported here rather than at boot: platform seeds resolve, a registered
 * factory resolves, and anything else — including a package-relative path to a
 * sibling file — fails exactly as "missed the module table" does in the shell.
 * @returns the require function.
 */
function makeRequire() {
  const cache = new Map()
  const platform = {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: react.Fragment },
    '@deepseek-ai/dsh-client-store': snapshotStore,
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  }
  const load = (specifier) => {
    if (cache.has(specifier)) return cache.get(specifier)
    if (Object.hasOwn(platform, specifier)) {
      cache.set(specifier, platform[specifier])
      return platform[specifier]
    }
    const factory = registered.get(specifier)
    if (factory === undefined) {
      throw new Error(
        `client-modules: require("${specifier}") missed the module table — not a platform seed word, ` +
          `not a materialized module, and no registered package factory`,
      )
    }
    const exports = factory(load)
    cache.set(specifier, exports)
    return exports
  }
  return load
}

// --- load the bundle the way the host does ----------------------------------
// Exactly one bundle: the loader materializes the entry and never discovers
// sibling files, so loading more than this would hide a violated rule.
{
  const source = await readFile(join(packageRoot, 'lib/client.js'), 'utf8')
  // The bundle reads `fetch` from its own scope, so the mock is injected as a
  // parameter rather than set on globalThis.
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'fetch', 'URLSearchParams', source)
  run(windowStub, documentStub, (...args) => globalThis.fetch(...args), URLSearchParams)
}
check('the entry registers exactly one factory', registered.size === 1, [...registered.keys()].join(', '))
check('the entry registers under the package id', registered.has('dsh-plugin-session-manager'))

let plugin
try {
  plugin = makeRequire()('dsh-plugin-session-manager')
  check('the entry materializes without a sibling require', true)
} catch (error) {
  check('the entry materializes without a sibling require', false, error.message)
}
check('the entry exports apply', typeof plugin.apply === 'function')
check('the entry declares its services', Array.isArray(plugin.inject) && plugin.inject.includes('slots'))

// --- activate against a stub context ----------------------------------------
const slotRegistrations = []
const provides = new Map()
const locales = []
const effects = []
let archiveCalls = []
const workspacesStub = {
  archiveSession: async (sessionId, options) => {
    archiveCalls.push({ sessionId, options })
  },
}
// The sidebar renders the Session Controller's cached list snapshot, so a
// removed session leaves a ghost row unless the baseline is re-pulled.
let baselineRefreshes = 0
const sessionsStub = {
  refresh: async () => {
    baselineRefreshes += 1
  },
}
const ctx = {
  provide: (name, value) => provides.set(name, value),
  effect: (fn, label) => {
    effects.push(label)
    return fn()
  },
  locale: { register: (ns, dicts) => locales.push({ ns, dicts }) },
  get: (name) => (name === 'workspaces' ? workspacesStub : name === 'sessions' ? sessionsStub : undefined),
  slots: {
    inject: (name, callback) => {
      slotRegistrations.push({ name, callback })
      return callback()
    },
    register: (options, component) => {
      slotRegistrations[slotRegistrations.length - 1].options = options
      slotRegistrations[slotRegistrations.length - 1].component = component
      return () => {}
    },
  },
}
plugin.apply(ctx)

check('it provides a controller service', provides.has('sessionManager'))
check('it registers two dictionary locales', locales.length === 1 && Object.keys(locales[0].dicts).length === 2, JSON.stringify(locales.map((l) => Object.keys(l.dicts))))
check('it reports effect labels', effects.every((label) => typeof label === 'string' && label.includes('session-manager')), effects.join(' | '))

const menuSlot = slotRegistrations.find((entry) => entry.name === 'sidebar.workspaces.session.menu.item')
const overlaySlot = slotRegistrations.find((entry) => entry.name === 'shell.overlay')
check('it injects the session row menu slot', menuSlot !== undefined)
check('it injects the overlay slot', overlaySlot !== undefined)
check('the row menu entry carries a namespaced id', menuSlot?.options?.id === 'session-manager')
check('the row menu entry sets an order', menuSlot?.options?.order === 500)
check('the row menu entry declares its locale', menuSlot?.options?.locale === 'session-manager')
check('the row menu entry exposes actions', typeof menuSlot?.options?.inject().requestRemove === 'function')
check('the overlay entry exposes confirmation', typeof overlaySlot?.options?.inject().confirmRemove === 'function')

// --- controller behaviour ---------------------------------------------------
const controller = provides.get('sessionManager')
const calls = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
  if (String(url).includes('/plan')) {
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          ok: true,
          id: 'session-a',
          entries: [{ id: 'session-a', bytes: 2048 }],
          descendants: ['session-b'],
          bytes: 2048,
          token: 'abc123',
          blocked: [],
        }),
    }
  }
  if (String(url).includes('/remove')) {
    return { ok: true, text: async () => JSON.stringify({ ok: true, code: 'session/removed', removed: [{ id: 'session-a' }] }) }
  }
  if (String(url).includes('/export')) {
    return { ok: true, text: async () => JSON.stringify({ ok: true, destination: 'C:/home/session-manager/exports/x' }) }
  }
  if (String(url).includes('session.export')) {
    return { ok: true, text: async () => '' }
  }
  return { ok: true, text: async () => JSON.stringify({ ok: true, items: [] }) }
}

const planned = await controller.requestRemove('session-a', 'A title')
check('planning opens a confirmation', planned.ok === true)
check('the confirmation carries the host plan', controller.store.getSnapshot().confirm?.plan?.token === 'abc123')
check('planning calls the document-relative plan route', calls.some((c) => c.url === 'api/session-manager/plan' && c.method === 'POST'))

const removed = await controller.confirmRemove({ force: false })
check('confirming removes the session', removed.ok === true)
check('the confirmation closes after success', controller.store.getSnapshot().confirm === null)
const removeCall = calls.find((c) => c.url === 'api/session-manager/remove')
check('removal sends the token', JSON.parse(removeCall.body).token === 'abc123')
check('removal does not force by default', JSON.parse(removeCall.body).force === false)

// A refused removal must keep the dialog open with the fresh reasons.
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
  if (String(url).includes('/plan')) {
    return { ok: true, text: async () => JSON.stringify({ ok: true, entries: [{ id: 'session-a', bytes: 1 }], descendants: [], token: 'tok', blocked: [] }) }
  }
  return {
    ok: true,
    text: async () =>
      JSON.stringify({ ok: false, code: 'session/blocked', message: 'blocked', blocked: [{ id: 'session-a', reason: 'live' }] }),
  }
}
await controller.requestRemove('session-a', 'A title')
const refused = await controller.confirmRemove({ force: false })
check('a refused removal reports failure', refused.ok === false)
check('a refused removal keeps the dialog open', controller.store.getSnapshot().confirm !== null)
check('a refused removal refreshes the blocking reasons', controller.store.getSnapshot().confirm.plan.blocked[0].reason === 'live')

// The row has to disappear with the artifacts. The sidebar renders the Session
// Controller's cached baseline, and the removal above went through the
// controller directly, so the refresh is asserted through the slot entry's
// injected action — that is the exact function the dialog calls.
const overlayActions = overlaySlot.options.inject()
globalThis.fetch = async (url) => (String(url).includes('/remove')
  ? { ok: true, text: async () => JSON.stringify({ ok: true, code: 'session/removed', removed: [{ id: 'session-a' }] }) }
  : { ok: true, text: async () => JSON.stringify({ ok: true, entries: [{ id: 'session-a', bytes: 1 }], descendants: [], token: 'tok', blocked: [] }) })
baselineRefreshes = 0
await controller.requestRemove('session-a', 'A title')
const confirmedThroughEntry = await overlayActions.confirmRemove({ force: false })
check('the overlay action confirms a removal', confirmedThroughEntry.ok === true)
check('a successful removal re-pulls the session baseline', baselineRefreshes === 1, `refreshes=${baselineRefreshes}`)

// A refused removal must not trigger a needless baseline pull.
globalThis.fetch = async (url) => (String(url).includes('/remove')
  ? { ok: true, text: async () => JSON.stringify({ ok: false, code: 'session/blocked', message: 'blocked', blocked: [{ id: 'session-a', reason: 'live' }] }) }
  : { ok: true, text: async () => JSON.stringify({ ok: true, entries: [{ id: 'session-a', bytes: 1 }], descendants: [], token: 'tok', blocked: [] }) })
baselineRefreshes = 0
await controller.requestRemove('session-a', 'A title')
const refusedThroughEntry = await overlayActions.confirmRemove({ force: true })
check('the overlay action reports a refusal', refusedThroughEntry.ok === false)
check('a refused removal does not re-pull the baseline', baselineRefreshes === 0, `refreshes=${baselineRefreshes}`)

globalThis.fetch = async (url) => {
  if (String(url).includes('session.export')) return { ok: false, status: 404, text: async () => '' }
  return { ok: true, text: async () => JSON.stringify({ ok: true }) }
}
const exportFailed = await controller.downloadZip('session-a')
check('a missing export route is reported, not silent', exportFailed.ok === false && exportFailed.message.includes('404'))

// The archive path must translate an activity refusal into "stop first".
globalThis.fetch = originalFetch
archiveCalls = []
const archived = await controller.archive(workspacesStub, 'session-a', false)
check('archiving a quiet session succeeds', archived.ok === true)
check('archiving passes no stop option by default', archiveCalls[0].options === undefined)
check('a successful archive asks for no stop', archived.needsStop === undefined)
const archivedForced = await controller.archive(workspacesStub, 'session-a', true)
check('archiving with stop passes the stop option', archiveCalls[1].options?.stopActivity === true)
check('a forced archive still succeeds', archivedForced.ok === true)

const workspacesRefusing = {
  archiveSession: async () => {
    throw Object.assign(new Error('active'), { rpcError: { code: 'workspace/session-active' } })
  },
}
const refusedArchive = await controller.archive(workspacesRefusing, 'session-b', false)
check('an activity refusal is recognized', refusedArchive.ok === false && refusedArchive.needsStop === true)

const workspacesOther = {
  archiveSession: async () => {
    throw new Error('boom')
  },
}
const otherFailure = await controller.archive(workspacesOther, 'session-c', false)
check('an unrelated archive failure is not treated as activity', otherFailure.needsStop === false)

// --- row menu component -----------------------------------------------------
// The row menu consumes `useMenuOpenState()` as a state tuple, exactly like the
// shipped entries (`const [, setMenuOpen] = useMenuOpenState()`). Rendering it
// with the real tuple shape is what catches a component that would otherwise
// leave the menu open after a click.
//
// The component is reached through the registered slot entry, not by requiring
// its own file: there is no per-file module, and requiring one fails.
const menuSlotOptions = menuSlot.options.inject()
let closed = 0
let menuHookCalls = 0
const menuProps = {
  sessionId: 'session-a',
  displayTitle: 'A title',
  ...menuSlotOptions,
  t: (key) => key,
  useSessionManager: (selector) => selector({ bySession: {}, confirm: null }),
  useMenuOpenState: () => {
    menuHookCalls += 1
    return [true, () => { closed += 1 }]
  },
}
react.__reset()
const rendered = menuSlot.component(menuProps)
check('the row menu renders a group', rendered !== null && rendered.type === 'MenuGroup', String(rendered?.type))
const items = rendered?.props?.children?.filter(Boolean) ?? []
check('the row menu renders four entries', items.length === 4, String(items.length))
check('the destructive entry is marked dangerous', items.some((item) => item?.props?.danger === true))
check(
  'the entries cover export, backup, archive and removal',
  items.length === 4 && items.every((item) => typeof item?.props?.onSelect === 'function'),
)

// Selecting an entry must close the row menu before the action runs, otherwise
// the row's own dismiss handling swallows the feedback.
let selectError = null
try {
  items[0].props.onSelect()
} catch (error) {
  selectError = error
}
check('selecting an entry does not throw', selectError === null, String(selectError))
check('the menu open-state hook was actually consumed', menuHookCalls > 0, `calls=${menuHookCalls}`)
check('selecting an entry closes the row menu', closed === 1, `closed=${closed}`)
react.__reset()

// --- confirmation dialog ----------------------------------------------------
// The dialog is the only thing standing between the menu click and a confirmed
// removal. If it renders nothing when a confirmation is pending, the click looks
// like it did nothing at all, so the pending and empty cases are both asserted
// against the component the overlay slot actually registered.
const dialogSlot = slotRegistrations.find((entry) => entry.name === 'shell.overlay')
const overlayOptions = dialogSlot.options.inject()
check('the overlay entry exposes a session-manager hook', overlayOptions.hooks?.sessionManager !== undefined)

const dialogProps = {
  ...overlayOptions,
  // A locale lookup that resolves real templates and interpolates like the real
  // one does. Returning bare keys would make any copy assertion vacuous, because
  // a key carries no placeholder for the interpolation to substitute.
  t: (key, params) => {
    const templates = { 'dialog.removeDescription': 'This moves "{title}" and its sub-sessions out of the store.' }
    const template = templates[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
  },
}
/**
 * Render one component while counting every hook it calls.
 *
 * React identifies hooks by call position, so a render that calls a different
 * number of hooks than the previous render of the same component throws
 * ("Rendered more hooks than during the previous render") and takes the whole
 * surface down. The stubbed hooks below are plain functions, so without this
 * counter a conditionally called hook passes here and only fails in the browser
 * — which is exactly how the confirmation dialog shipped: it returned `null`
 * before its second hook, so it could never render once a confirmation was
 * pending.
 * @param component - the component under test.
 * @param props - its props.
 * @returns the render result and the number of hooks it called.
 */
function renderCountingHooks(component, props) {
  react.__reset()
  let injected = 0
  const rendered = component({
    ...props,
    useSessionManager: (selector) => {
      injected += 1
      return props.useSessionManager(selector)
    },
  })
  return { rendered, hooks: react.__hookCalls + injected }
}

const emptyRender = renderCountingHooks(dialogSlot.component, {
  ...dialogProps,
  useSessionManager: (selector) => selector({ bySession: {}, confirm: null }),
})
const emptyDialog = emptyRender.rendered
check('the dialog renders nothing with no pending confirmation', emptyDialog === null, String(emptyDialog?.type))

const pendingPlan = {
  entries: [{ id: 'session-a', bytes: 4096 }],
  descendants: ['session-b'],
  bytes: 4096,
  token: 'tok',
  blocked: [],
}
const pendingRender = renderCountingHooks(dialogSlot.component, {
  ...dialogProps,
  useSessionManager: (selector) =>
    selector({ bySession: {}, confirm: { sessionId: 'session-a', displayTitle: 'ZZTITLE', plan: pendingPlan } }),
})
const pendingDialog = pendingRender.rendered
check(
  'the dialog calls the same number of hooks with and without a pending confirmation',
  pendingRender.hooks === emptyRender.hooks,
  `pending=${pendingRender.hooks} empty=${emptyRender.hooks}`,
)
check('the dialog uses the hook it is handed', pendingRender.hooks > 0, String(pendingRender.hooks))
check('the dialog renders a Modal when a confirmation is pending', pendingDialog?.type === 'Modal', String(pendingDialog?.type))
const pendingDescription = pendingDialog?.props?.description
const footer = pendingDialog?.props?.footer
const footerButtons = footer?.props?.children?.filter(Boolean) ?? []
check('the dialog offers a cancel and a confirm action', footerButtons.length === 2, String(footerButtons.length))
check('the confirm action is styled as destructive', String(footerButtons[1]?.props?.className ?? '').includes('Danger'), String(footerButtons[1]?.props?.className))
check(
  'the dialog names the session it will remove',
  typeof pendingDescription === 'string' && pendingDescription.includes('ZZTITLE'),
  `description=${JSON.stringify(pendingDescription)}`,
)

// A blocked plan must render its reasons and switch the confirm label.
const blockedRender = renderCountingHooks(dialogSlot.component, {
  ...dialogProps,
  useSessionManager: (selector) =>
    selector({
      bySession: {},
      confirm: {
        sessionId: 'session-a',
        displayTitle: 'A',
        plan: { ...pendingPlan, blocked: [{ id: 'session-a', reason: 'live' }] },
      },
    }),
})
const blockedDialog = blockedRender.rendered
const blockedFooter = blockedDialog?.props?.footer?.props?.children?.filter(Boolean) ?? []
check('a blocked plan changes the confirm label', blockedFooter[1]?.props?.children === 'dialog.forceRemove', String(blockedFooter[1]?.props?.children))
check(
  'a blocked plan calls the same number of hooks',
  blockedRender.hooks === pendingRender.hooks,
  `blocked=${blockedRender.hooks} pending=${pendingRender.hooks}`,
)
react.__reset()

globalThis.fetch = originalFetch
console.log(`\nfailures=${failures}`)
process.exit(failures === 0 ? 0 : 1)



