/**
 * End-to-end check of the host HTTP layer.
 *
 * Every previous suite tested the operations service directly or the client
 * bundle in isolation. This one drives the real route handlers the browser
 * calls, which is the layer the delete button depends on, so a wrong path, a
 * wrong status, or a broken plan/remove handshake shows up here.
 *
 * It runs against a disposable copy of a real sessions root and never touches
 * the original.
 *
 * Run with the bundled Node:
 *   node tests/check-routes.mjs <real-sessions-root>
 */

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { trashRoot } from '../lib/trash.js'

const realRoot = process.argv[2]
if (realRoot === undefined) {
  console.error('usage: check-routes.mjs <real-sessions-root>')
  process.exit(2)
}

let failures = 0
/** Record one assertion result. */
function check(label, condition, detail = '') {
  if (condition) console.log(`OK    ${label}`)
  else {
    failures += 1
    console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-session-manager-routes-'))
const home = join(sandbox, 'home')
const root = join(home, 'sessions')
await cp(realRoot, root, { recursive: true })

// Activate the host half exactly as the loader does, capturing what it registers.
const plugin = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href)
const routes = new Map()
const commands = new Map()
const ctx = {
  get: (name) => {
    if (name === 'connection') {
      return {
        fetch: {
          register: (spec) => {
            routes.set(spec.path, { methods: spec.methods, fetch: spec.fetch })
            return () => {}
          },
        },
      }
    }
    if (name === 'commands') {
      return {
        register: (definition) => {
          commands.set(definition.name, definition)
          return () => {}
        },
      }
    }
    if (name === 'sessions') return { get: () => undefined, list: () => [], flush: async () => {} }
    // No `homePaths`: the real desktop composition has no such service, so the
    // sandbox home is passed as configuration instead.
    return undefined
  },
  provide: () => {},
  effect: (fn) => fn(),
  logger: { warn: () => {} },
}

plugin.apply(ctx, { home, sessionsRoot: root, storagesRoot: join(home, 'storages'), trashRoot: trashRoot(home) })

check('the host half registers routes', routes.size > 0, [...routes.keys()].join(', '))
const listPath = '/api/session-manager'
const planPath = `${listPath}/plan`
const removePath = `${listPath}/remove`
const exportPath = `${listPath}/export`
check('the listing route exists', routes.has(listPath))
check('the plan route exists', routes.has(planPath))
check('the remove route exists', routes.has(removePath))
check('the export route exists', routes.has(exportPath))
check('the plan route accepts POST', routes.get(planPath)?.methods?.includes('POST'), JSON.stringify(routes.get(planPath)?.methods))

/** Drive one registered route the way the browser does. */
async function hit(path, { method = 'GET', body } = {}) {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`no route registered at ${path}`)
  if (!route.methods.includes(method)) throw new Error(`route ${path} rejects ${method}`)
  const request = new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
  const response = await route.fetch(request)
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

const listed = await hit(listPath)
check('listing answers 200', listed.status === 200, String(listed.status))
check('listing reports ok', listed.body?.ok === true, JSON.stringify(listed.body)?.slice(0, 120))
check('listing returns items', Array.isArray(listed.body?.items) && listed.body.items.length > 0, String(listed.body?.items?.length))
check('listing reports the sessions root', listed.body?.root === root, String(listed.body?.root))

const target = listed.body.items.find((item) => item.hasDirectory === true)
check('the listing exposes a session with a directory', target !== undefined, JSON.stringify(listed.body.items?.[0]))

const planned = await hit(planPath, { method: 'POST', body: { id: target.id } })
check('plan answers 200', planned.status === 200, String(planned.status))
check('plan reports ok', planned.body?.ok === true, JSON.stringify(planned.body)?.slice(0, 200))
check('plan issues a 32-character token', planned.body?.token?.length === 32, String(planned.body?.token))
check('plan names the session directories it would remove', Array.isArray(planned.body?.entries) && planned.body.entries.length > 0)

const badRequest = await hit(planPath, { method: 'POST', body: {} })
check('plan rejects a missing id with 400', badRequest.status === 400, String(badRequest.status))

const noToken = await hit(removePath, { method: 'POST', body: { id: target.id } })
check('remove rejects a missing token with 400', noToken.status === 400, String(noToken.status))

const wrongToken = await hit(removePath, { method: 'POST', body: { id: target.id, token: 'nope' } })
check('remove refuses a bad token', wrongToken.body?.ok === false && wrongToken.body?.code === 'session/confirmation-mismatch', JSON.stringify(wrongToken.body)?.slice(0, 160))

// The plan/remove handshake the delete button performs, end to end over HTTP.
const removed = await hit(removePath, { method: 'POST', body: { id: target.id, token: planned.body.token, force: true } })
check('remove executes with the issued token', removed.body?.ok === true, JSON.stringify(removed.body)?.slice(0, 200))
check('remove reports the trashed session', Array.isArray(removed.body?.removed) && removed.body.removed.length > 0, JSON.stringify(removed.body?.removed))

const afterRemoval = await hit(listPath)
const stillListed = afterRemoval.body.items.some((item) => item.id === target.id)
check('the removed session is gone from the next listing', stillListed === false)

const trashed = await hit(`${listPath}/trash`)
check('the trash route lists the removal', trashed.body?.items?.length > 0, JSON.stringify(trashed.body)?.slice(0, 160))
check('the trashed entry records its session id', trashed.body.items.some((entry) => entry.id === target.id))

const exported = await hit(exportPath, { method: 'POST', body: { ids: [target.id], includeDescendants: false } })
check('export answers 200', exported.status === 200, String(exported.status))

// The `/sessions` command is the quickest user-visible signal that the host half
// is live; a failure here means the plugin never activated.
check('the /sessions command is registered', commands.has('sessions'))
if (commands.has('sessions')) {
  const result = await commands.get('sessions').handler({ rawInput: '' })
  check('the /sessions command returns success', result?.kind === 'success', JSON.stringify(result))
  check('the /sessions command reports stored sessions', /stored session/u.test(result?.text ?? ''), String(result?.text))
  const withArgs = await commands.get('sessions').handler({ rawInput: 'x' })
  check('the /sessions command refuses arguments', withArgs?.kind === 'error', JSON.stringify(withArgs))
}

await rm(sandbox, { recursive: true, force: true })
console.log(`\nfailures=${failures}`)
process.exit(failures === 0 ? 0 : 1)
