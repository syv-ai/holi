/** Vault → mirror-clone materialization. Full-tree every time: write all doc
 * texts, delete anything else, `git add -A` — git computes the real delta, so
 * unchanged content produces no commit.
 *
 * Two sources, not one. Docs carry their own `path` and their text lives in Yjs;
 * **tasks are a separate table with no path at all**, so they are absent from the
 * mirror by construction rather than by a filter, and getting them in is a second
 * query rather than a tweak. Their path is derived (`taskFilePath`) and their bytes
 * are rendered by the same `serializeTaskFile` the desktop projector uses. */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { isLocalOnlyPath, serializeTaskFile, taskFilePath } from '@holi/shared'
import { config } from '../config'
import type { Db } from '../db/client'
import { docs, folders, tasks, yjsDocs } from '../db/schema'
import { toTask } from '../db/mappers'
import { docFromState, docText } from '../yjs/doc-store'
import { git, tryGit } from './git'

export async function buildExportFiles(db: Db, vaultId: string): Promise<Map<string, string>> {
  const [contentRows, docRows, taskRows, folderRows] = await Promise.all([
    db
      .select({ path: docs.path, state: yjsDocs.state })
      .from(docs)
      .innerJoin(yjsDocs, eq(yjsDocs.docId, docs.id))
      .where(eq(docs.vaultId, vaultId)),
    // Every doc, NOT just the ones with Yjs state: a `related[]` note ref must render
    // as a path even for a doc that has no content row yet, or the inner join above
    // would quietly turn it into an id-tombstone — a real ref, rendered as a dead one.
    db.select({ id: docs.id, path: docs.path }).from(docs).where(eq(docs.vaultId, vaultId)),
    db.select().from(tasks).where(eq(tasks.vaultId, vaultId)),
    db.select().from(folders).where(eq(folders.vaultId, vaultId)),
  ])

  const files = new Map<string, string>()
  for (const row of contentRows) {
    if (isLocalOnlyPath(row.path)) continue
    files.set(row.path, docText(docFromState(row.state)))
  }

  // The record stores stable ids; the file renders paths — so renaming a note or a
  // folder never rewrites a task record, and the agent can name things it can see.
  const notePaths = new Map(docRows.map((d) => [d.id, d.path]))
  const folderPaths = new Map(folderRows.map((f) => [f.id, f.path]))
  const resolvers = {
    notePathFor: (docId: string) => notePaths.get(docId),
    folderPathFor: (folderId: string) => folderPaths.get(folderId),
  }

  // Tasks are written last: they win a path collision with a doc that somehow sits
  // under tasks/ (the desktop mirror cannot create one, but a commit predating this
  // feature could have). The ingester keeps new ones from appearing.
  for (const row of taskRows) {
    files.set(taskFilePath(row), serializeTaskFile(toTask(row), resolvers))
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
