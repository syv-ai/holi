/**
 * Add the shipped files' hashes to `src/main/vault/seed/shipped-history.json`:
 * every version of every skill and hook Holi has shipped, by vault path, so
 * `holi skills update` can tell a vault's untouched copy of an older version
 * from one the vault changed, with no record of what it seeded.
 *
 *   pnpm --filter @holi/desktop shipped-history             this tree's texts
 *   pnpm --filter @holi/desktop shipped-history --from-git  and every version
 *                                                           in the history
 *
 * Only ever adds: a vault may hold any version a release once shipped.
 * Run it whenever a shipped file changes; a test fails until it has been.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const src = join(desktop, 'src')
const out = join(src, 'main/vault/seed/shipped-history.json')

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * A source path's vault path, or null: the part after a seed folder's
 * `vault/shipped/` (or `vault/once/`), wherever the folder has lived, and the
 * agent's `hooks/` and `skills/` from before seed folders existed.
 */
function vaultPath(path) {
  const seeded = /(?:^|\/)vault\/(?:shipped|once)\/(.+)$/.exec(path)
  if (seeded) return seeded[1]
  const agent = /^apps\/desktop\/src\/main\/agent\/(hooks|skills)\/(.+)$/.exec(path)
  return agent ? `.claude/${agent[1]}/${agent[2]}` : null
}

/** This tree's shipped files: vault path to text. */
function current() {
  const files = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name !== '.DS_Store') {
        const match = /(?:^|\/)vault\/shipped\/(.+)$/.exec(relative(src, path).split(sep).join('/'))
        if (match) files.set(match[1], readFileSync(path))
      }
    }
  }
  walk(src)
  return files
}

const git = (args, input) => execFileSync('git', args, { cwd: desktop, input, maxBuffer: 1 << 30 })

/** Every blob the history ever held at a path that maps to one of `rels`,
 *  oldest first: vault path to blob ids. */
function blobsInHistory(rels) {
  const raw = git([
    '-c',
    'core.quotePath=false',
    'log',
    '-m',
    '--reverse',
    '--no-renames',
    '--raw',
    '--no-abbrev',
    '--format=',
    'HEAD',
    '--',
    ':/apps/desktop/src',
  ]).toString('utf8')
  const blobs = new Map()
  for (const line of raw.split('\n')) {
    const match = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) \w+\t(.+)$/.exec(line)
    if (!match || /^0+$/.test(match[1])) continue
    const rel = vaultPath(match[2])
    if (rel === null || !rels.has(rel)) continue
    const list = blobs.get(rel) ?? []
    if (!list.includes(match[1])) list.push(match[1])
    blobs.set(rel, list)
  }
  return blobs
}

/** Each blob's bytes, hashed: blob id to sha256. */
function hashBlobs(ids) {
  const hashes = new Map()
  if (ids.length === 0) return hashes
  const batch = git(['cat-file', '--batch'], ids.join('\n') + '\n')
  let at = 0
  while (at < batch.length) {
    const eol = batch.indexOf(0x0a, at)
    const [id, , size] = batch.subarray(at, eol).toString('utf8').split(' ')
    const start = eol + 1
    hashes.set(id, sha256(batch.subarray(start, start + Number(size))))
    at = start + Number(size) + 1
  }
  return hashes
}

const history = JSON.parse(readFileSync(out, 'utf8'))
const add = (rel, sha) => {
  const list = (history[rel] ??= [])
  if (!list.includes(sha)) list.push(sha)
}

const files = current()
if (process.argv.includes('--from-git')) {
  const blobs = blobsInHistory(new Set(files.keys()))
  const hashes = hashBlobs([...new Set([...blobs.values()].flat())])
  for (const [rel, ids] of blobs) for (const id of ids) add(rel, hashes.get(id))
}
for (const [rel, bytes] of files) add(rel, sha256(bytes))

const sorted = Object.fromEntries(
  Object.keys(history)
    .sort()
    .map((rel) => [rel, history[rel]]),
)
writeFileSync(out, JSON.stringify(sorted, null, 2) + '\n')
console.log(`${out}: ${Object.values(sorted).flat().length} versions of ${files.size} files`)
