/**
 * Ad-hoc verification for the session log reader against real session
 * artifacts. Run with the bundled Node:
 *   node tests/check-log-reader.mjs <sessions-root>
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readRawSessionLogText, parseLogLines, scanZstdFrames } from '../lib/log-reader.js'

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: check-log-reader.mjs <sessions-root>')
  process.exit(2)
}

/** Every session directory under one sessions root. */
async function listSessionDirs(home) {
  const result = []
  for (const project of await readdir(home, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(home, project.name)
    for (const session of await readdir(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      result.push({ project: project.name, id: session.name, dir: join(projectDir, session.name) })
    }
  }
  return result
}

let failures = 0
let checked = 0
for (const session of await listSessionDirs(root)) {
  const raw = await readRawSessionLogText(session.dir)
  if (raw === undefined) {
    console.log(`SKIP  ${session.id}: no log artifact`)
    continue
  }
  const { lines, unparsedLines } = parseLogLines(raw.text)
  const header = lines[0]
  const problems = []
  if (unparsedLines !== 0) problems.push(`unparsed lines: ${unparsedLines}`)
  if (raw.tornBytes !== 0) problems.push(`torn tail bytes: ${raw.tornBytes}`)
  if (header?.type !== 'session') problems.push(`first line is not a session header: ${header?.type}`)
  if (header?.id !== undefined && header.id !== session.id) {
    problems.push(`header id "${header.id}" does not match directory "${session.id}"`)
  }
  const seqs = lines.slice(1).map((line) => line.seq)
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i) {
      problems.push(`seq gap at index ${i}: got ${seqs[i]}`)
      break
    }
  }
  const size = (await stat(join(session.dir, raw.fileName))).size
  const frames = raw.fileName.endsWith('.zstd') ? scanZstdFrames(await (await import('node:fs/promises')).readFile(join(session.dir, raw.fileName))).frames.length : 0
  checked += 1
  if (problems.length === 0) {
    console.log(`OK    ${session.id}: ${lines.length} lines, ${frames} frames, ${size} bytes on disk`)
  } else {
    failures += 1
    console.log(`FAIL  ${session.id}: ${problems.join('; ')}`)
  }
}
console.log(`\nchecked=${checked} failures=${failures}`)
process.exit(failures === 0 ? 0 : 1)
