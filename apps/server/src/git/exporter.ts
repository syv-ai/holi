/** Vault → mirror-clone materialization. Full-tree every time: write all doc
 * texts, delete anything else, `git add -A` — git computes the real delta, so
 * unchanged content produces no commit. */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { config } from '../config'
import type { Db } from '../db/client'
import { docs, yjsDocs } from '../db/schema'
import { docFromState, docText } from '../yjs/doc-store'
import { git, tryGit } from './git'

/** `*.local.*` anywhere in the basename is machine-local — never exported. */
export function isLocalOnlyPath(path: string): boolean {
  const base = path.split('/').at(-1) ?? path
  return /\.local\./.test(base)
}

export async function buildExportFiles(db: Db, vaultId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ path: docs.path, state: yjsDocs.state })
    .from(docs)
    .innerJoin(yjsDocs, eq(yjsDocs.docId, docs.id))
    .where(eq(docs.vaultId, vaultId))
  const files = new Map<string, string>()
  for (const row of rows) {
    if (isLocalOnlyPath(row.path)) continue
    files.set(row.path, docText(docFromState(row.state)))
  }
  return files
}

/** Replace the clone's working tree (everything but .git) with `files`. */
export async function writeExportTree(cloneDir: string, files: Map<string, string>): Promise<void> {
  for (const entry of await readdir(cloneDir)) {
    if (entry === '.git') continue
    await rm(join(cloneDir, entry), { recursive: true, force: true })
  }
  for (const [path, text] of files) {
    const abs = join(cloneDir, path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
}

/** Materialize + commit as the bot. Returns the new commit sha, or null when
 * the tree is unchanged (nothing to commit). Does NOT push. */
export async function exportCommit(db: Db, vaultId: string, cloneDir: string): Promise<string | null> {
  const files = await buildExportFiles(db, vaultId)
  await writeExportTree(cloneDir, files)
  await git(['add', '-A'], cloneDir)
  const status = await git(['status', '--porcelain'], cloneDir)
  const headExists = (await tryGit(['rev-parse', 'HEAD'], cloneDir)).ok
  if (status === '' && headExists) return null
  const changed = status === '' ? 0 : status.split('\n').length
  await git(
    [
      '-c',
      `user.name=${config.git.botName}`,
      '-c',
      `user.email=${config.git.botEmail}`,
      'commit',
      '--allow-empty',
      '-m',
      `holi sync: ${changed} path(s) changed`,
    ],
    cloneDir,
  )
  return git(['rev-parse', 'HEAD'], cloneDir)
}
