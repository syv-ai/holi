/** Task files in the git mirror, both directions (plan 2026-07-14-task-file-git-mirror).
 *
 * Real Postgres, real git, never the network: a bare repo stands in for the remote,
 * and a commit authored by a foreign email is what "a remote agent pushed" means —
 * the bot's own commits are filtered by author, so anything the exporter wrote never
 * ingests back. */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { parseTaskFile, taskFilePath } from '@holi/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus } from '../src/bus'
import { encryptionKey, seal } from '../src/crypto'
import { docs, folders, tasks, vaultGit } from '../src/db/schema'
import { git } from '../src/git/git'
import { syncVault } from '../src/git/sync'
import { createTestDb, type TestDb } from '../src/test/db'
import { commitAll, initBareRepo, initWorkdir } from '../src/test/git'
import { seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
const cleanups: string[] = []
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => {
  await t.destroy()
  for (const d of cleanups) await rm(d, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-gittasks-'))
  cleanups.push(dir)
  return dir
}

async function gitVault() {
  const user = await seedUser(t.db)
  const vault = await seedVault(t.db, user.id)
  const dir = await scratch()
  const bare = await initBareRepo(join(dir, 'remote.git'))
  const key = encryptionKey()
  await t.db.insert(vaultGit).values({
    vaultId: vault.id,
    repoUrl: `https://github.com/test/${vault.id}`,
    remote: bare,
    defaultBranch: 'main',
    deployKeyCiphertext: seal('unused-for-file-remotes', key),
    deployKeyPublic: 'unused',
    webhookSecretCiphertext: seal('whsec', key),
    enabledBy: user.id,
  })
  return { vault, bare, mirrorDir: join(dir, 'mirrors'), user }
}

const deps = (mirrorDir: string) => ({ db: t.db, bus: createBus(), getLiveDoc: () => null, mirrorDir })

async function seedTask(vaultId: string, over: Partial<typeof tasks.$inferInsert> = {}) {
  const [row] = await t.db
    .insert(tasks)
    .values({ vaultId, title: 'Review the Q2 doc', status: 'todo', ...over })
    .returning()
  return row!
}

/** A working clone of the remote — what a remote Claude Code session actually has. */
async function clone(bare: string): Promise<string> {
  const dir = await scratch()
  const wd = await initWorkdir(join(dir, 'clone'))
  await git(['remote', 'add', 'origin', bare], wd)
  await git(['fetch', 'origin'], wd)
  await git(['checkout', '-B', 'main', 'origin/main'], wd)
  return wd
}

async function remoteFile(bare: string, path: string): Promise<string | null> {
  const wd = await clone(bare)
  try {
    return await git(['show', `origin/main:${path}`], wd)
  } catch {
    return null
  }
}

/** Write a file in the clone and push it as somebody who is not the bot. */
async function pushAs(wd: string, path: string, text: string | null): Promise<void> {
  const abs = join(wd, path)
  if (text === null) await rm(abs, { force: true })
  else {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, text, 'utf8')
  }
  await commitAll(wd, `remote edit ${path}`, 'remote-agent@else.dev')
  await git(['push', 'origin', 'main'], wd)
}

const taskById = async (id: string) => (await t.db.select().from(tasks).where(eq(tasks.id, id)))[0]

describe('git mirror — task files are exported', () => {
  it('a task is exported as tasks/<slug>-<id>.md and parses back to its fields', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    const task = await seedTask(vault.id, { due: '2026-07-20', priority: 'high', tags: ['q2'] })

    await syncVault(deps(mirrorDir), vault.id)

    const rel = taskFilePath(task)
    expect(rel).toBe(`tasks/review-the-q2-doc-${task.id}.md`)
    const text = await remoteFile(bare, rel)
    expect(text).not.toBeNull()
    const parsed = parseTaskFile(text!)
    expect(parsed.id).toBe(task.id)
    expect(parsed.fields).toMatchObject({
      title: 'Review the Q2 doc',
      status: 'todo',
      due: '2026-07-20',
      priority: 'high',
      tags: ['q2'],
    })
  })

  it('renders area as a folder path and a related note as its path', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    const [folder] = await t.db.insert(folders).values({ vaultId: vault.id, path: 'projects/q2' }).returning()
    const [doc] = await t.db
      .insert(docs)
      .values({ vaultId: vault.id, path: 'meetings/kickoff.md', kind: 'note' })
      .returning()
    const task = await seedTask(vault.id, {
      area: folder!.id,
      related: [{ kind: 'note', id: doc!.id }],
    })

    await syncVault(deps(mirrorDir), vault.id)

    const parsed = parseTaskFile((await remoteFile(bare, taskFilePath(task)))!)
    expect(parsed.fields.area).toBe('projects/q2')
    expect(parsed.fields.related).toEqual([{ kind: 'note', path: 'meetings/kickoff.md' }])
  })

  it('a deleted folder unfiles its tasks — the export drops `area`, it does not tombstone', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    const [folder] = await t.db.insert(folders).values({ vaultId: vault.id, path: 'doomed' }).returning()
    const task = await seedTask(vault.id, { area: folder!.id })
    await t.db.delete(folders).where(eq(folders.id, folder!.id)) // ON DELETE SET NULL

    await syncVault(deps(mirrorDir), vault.id)

    // the task outlived its folder and fell into "(no area)" — there is nothing to
    // tombstone, because it no longer points at anything
    expect((await taskById(task.id))!.area).toBeNull()
    expect(parseTaskFile((await remoteFile(bare, taskFilePath(task)))!).fields.area).toBeUndefined()
  })

  /** The one that keeps the bot from talking to itself forever. If serialize does not
   * round-trip byte-exactly through parse + Postgres, the export re-materializes bytes
   * that differ from the committed ones, and the bot commits a "correction" on every
   * sync pass of an idle vault, until the end of time. */
  it('an idle vault produces no second commit', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    await seedTask(vault.id, {
      due: '2026-07-20',
      tags: ['a', 'b'],
      recurrence: { frequency: 'weekly', interval: 1, weekdays: ['mon'] },
      description: 'A body.\n\nWith two paragraphs.',
    })

    await syncVault(deps(mirrorDir), vault.id)
    const first = await git(['rev-parse', 'origin/main'], await clone(bare))

    await syncVault(deps(mirrorDir), vault.id)
    await syncVault(deps(mirrorDir), vault.id)
    const after = await git(['rev-parse', 'origin/main'], await clone(bare))

    expect(after).toBe(first)
  })
})

describe('git mirror — task files ingest as records, never as docs', () => {
  /** The landmine: createDoc hardcodes kind:'note', and every unrouted inbound path
   * ends there. A task file reaching it becomes a CRDT note — the exact failure the
   * desktop side spent all of slice 1 preventing, arriving through the other door. */
  it('a foreign commit under tasks/ creates NO doc', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    await seedTask(vault.id) // so the mirror has a base commit
    await syncVault(deps(mirrorDir), vault.id)

    const wd = await clone(bare)
    await pushAs(wd, 'tasks/hand-written.md', '---\ntitle: Written remotely\nstatus: todo\n---\n\nBody.\n')
    await syncVault(deps(mirrorDir), vault.id)

    const docRows = await t.db.select().from(docs).where(eq(docs.vaultId, vault.id))
    expect(docRows).toEqual([])
  })

  it('a remote task file with no id becomes a record, renamed to its canonical path', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    await seedTask(vault.id)
    await syncVault(deps(mirrorDir), vault.id)

    const wd = await clone(bare)
    await pushAs(wd, 'tasks/hand-written.md', '---\ntitle: Written remotely\nstatus: doing\n---\n\nBody.\n')
    await syncVault(deps(mirrorDir), vault.id)

    const [created] = await t.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.vaultId, vault.id), eq(tasks.title, 'Written remotely')))
    expect(created).toBeDefined()
    expect(created!.status).toBe('doing')
    expect(created!.description).toBe('Body.')
    // the export renames it; git renders that as a rename
    expect(await remoteFile(bare, 'tasks/hand-written.md')).toBeNull()
    expect(await remoteFile(bare, taskFilePath(created!))).not.toBeNull()
  })

  /** D34 — the commit's own base blob is the diff base, so the patch is exact and a
   * field the remote writer never touched survives a concurrent local change to it. */
  it('a remote edit lands as a per-field patch — an untouched field survives', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    const task = await seedTask(vault.id, { priority: 'low' })
    await syncVault(deps(mirrorDir), vault.id)

    const wd = await clone(bare)
    const rel = taskFilePath(task)
    const text = await readFile(join(wd, rel), 'utf8')

    // meanwhile, the board moves the card — a field the remote writer never touched
    await t.db.update(tasks).set({ status: 'doing' }).where(eq(tasks.id, task.id))

    await pushAs(wd, rel, text.replace('title: Review the Q2 doc', 'title: Retitled remotely'))
    await syncVault(deps(mirrorDir), vault.id)

    const row = await taskById(task.id)
    expect(row!.title).toBe('Retitled remotely')
    expect(row!.status).toBe('doing') // the untouched field survived — this is the payoff
    expect(row!.priority).toBe('low')
  })

  it('rm of a task file in the repo deletes the record', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    const task = await seedTask(vault.id)
    await syncVault(deps(mirrorDir), vault.id)

    const wd = await clone(bare)
    await pushAs(wd, taskFilePath(task), null)
    await syncVault(deps(mirrorDir), vault.id)

    expect(await taskById(task.id)).toBeUndefined()
  })

  it('an unparseable remote task file is warned about and changes nothing', async () => {
    const { vault, bare, mirrorDir } = await gitVault()
    const task = await seedTask(vault.id)
    await syncVault(deps(mirrorDir), vault.id)

    const wd = await clone(bare)
    // an unquoted colon in the title — invalid YAML, and exactly what a model writes
    await pushAs(wd, taskFilePath(task), '---\ntitle: Review: the Q2 doc\nstatus: todo\n---\n')
    await syncVault(deps(mirrorDir), vault.id)

    expect((await taskById(task.id))!.title).toBe('Review the Q2 doc') // untouched
    expect(await t.db.select().from(docs).where(eq(docs.vaultId, vault.id))).toEqual([]) // NOT a note
    const [row] = await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))
    expect(row!.warnings.some((w) => w.kind === 'task-file-unparseable')).toBe(true)
  })
})
