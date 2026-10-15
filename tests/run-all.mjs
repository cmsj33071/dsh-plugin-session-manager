/**
 * Run every check in sequence.
 *
 * The first two checks are self-contained. The last one needs a real sessions
 * root because it verifies the plugin against actual session artifacts, but it
 * copies that root into a temporary directory and never writes to the original.
 *
 * Usage:
 *   node tests/run-all.mjs [sessions-root]
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sessionsRoot = process.argv[2]

const suites = [
  ['manifest contract', join(here, 'check-manifest.mjs'), []],
  ['client bundle', join(here, 'check-client.mjs'), []],
  ['lineage and safety rules', join(here, 'check-lineage.mjs'), []],
  ['host HTTP layer', join(here, 'check-routes.mjs'), sessionsRoot === undefined ? null : [sessionsRoot]],
  ['reader against real artifacts', join(here, 'check-log-reader.mjs'), sessionsRoot === undefined ? null : [sessionsRoot]],
  ['operations against a real copy', join(here, 'check-operations.mjs'), sessionsRoot === undefined ? null : [sessionsRoot]],
]

let failed = 0
for (const [label, script, args] of suites) {
  if (args === null) {
    console.log(`\n=== ${label}: SKIPPED (pass a sessions root to enable) ===`)
    continue
  }
  console.log(`\n=== ${label} ===`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' })
    child.on('close', resolve)
  })
  if (code !== 0) failed += 1
}

console.log(`\n${failed === 0 ? 'all suites passed' : `${failed} suite(s) failed`}`)
process.exit(failed === 0 ? 0 : 1)
