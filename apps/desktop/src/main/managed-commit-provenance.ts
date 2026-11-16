import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { jsonFileStore } from './json-file-store'
import { canonicalGitHubRemote } from './mdx-trust'

interface ProvenanceKey {
  remote: string
  root: string
  gitDir: string
  device: number
  inode: number
  lifetime: string
  oid: string
}

type ProvenanceRecord = ProvenanceKey &
  (
    | (CommitIdentity & { conflicted?: never })
    | { conflicted: true; accountId?: never; generation?: never }
  )

interface ProvenanceFile {
  version: 1
  records: ProvenanceRecord[]
}

export interface CommitIdentity {
  accountId: number
  generation: number
}

const empty = (): ProvenanceFile => ({ version: 1, records: [] })

function provenanceKey(key: ProvenanceKey): string {
  return JSON.stringify([
    key.remote,
    key.root,
    key.gitDir,
    key.device,
    key.inode,
    key.lifetime,
    key.oid,
  ])
}

function parse(raw: unknown, text: string | null): ProvenanceFile {
  if (text === null) return empty()
  if (
    raw === null ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    (raw as { version?: unknown }).version !== 1 ||
    !Array.isArray((raw as { records?: unknown }).records)
  )
    throw new Error('Managed commit provenance is invalid; it was not changed.')
  const records = (raw as { records: unknown[] }).records
  if (!records.every(isRecord))
    throw new Error('Managed commit provenance is invalid; it was not changed.')
  const keys = records.map(provenanceKey)
  if (new Set(keys).size !== keys.length)
    throw new Error('Duplicate managed commit provenance; it was not changed.')
  return { version: 1, records }
}

function isRecord(value: unknown): value is ProvenanceRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  let remoteIsCanonical = false
  try {
    remoteIsCanonical = typeof r.remote === 'string' && canonicalGitHubRemote(r.remote) === r.remote
  } catch {
    remoteIsCanonical = false
  }
  return (
    (r.conflicted === undefined || r.conflicted === true) &&
    remoteIsCanonical &&
    typeof r.root === 'string' &&
    isAbsolute(r.root) &&
    typeof r.gitDir === 'string' &&
    isAbsolute(r.gitDir) &&
    Number.isSafeInteger(r.device) &&
    Number.isSafeInteger(r.inode) &&
    typeof r.lifetime === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(r.lifetime) &&
    typeof r.oid === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(r.oid) &&
    (r.conflicted === true
      ? r.accountId === undefined && r.generation === undefined
      : Number.isSafeInteger(r.accountId) &&
        (r.accountId as number) > 0 &&
        Number.isSafeInteger(r.generation) &&
        (r.generation as number) >= 0)
  )
}

async function repositoryIdentity(
  root: string,
): Promise<Pick<ProvenanceRecord, 'root' | 'gitDir' | 'device' | 'inode' | 'lifetime'>> {
  const canonicalRoot = await realpath(root)
  const gitDirRaw = await (
    await import('./git')
  ).runGit(canonicalRoot, ['--no-replace-objects', 'rev-parse', '--absolute-git-dir'], {
    executionBudget: { maxBuffer: 65536, timeout: 1000 },
  })
  const gitDir = await realpath(gitDirRaw)
  const gitStat = await stat(gitDir)
  const lifetimeFile = `${gitDir}/holi-managed-provenance-id`
  let lifetime: string
  try {
    lifetime = (await readFile(lifetimeFile, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const candidate = randomUUID()
    try {
      const handle = await open(lifetimeFile, 'wx', 0o600)
      try {
        await handle.writeFile(`${candidate}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      lifetime = candidate
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError
      lifetime = (await readFile(lifetimeFile, 'utf8')).trim()
    }
  }
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(lifetime))
    throw new Error('Invalid repository lifetime marker')
  return {
    root: canonicalRoot,
    gitDir,
    device: Number(gitStat.dev),
    inode: Number(gitStat.ino),
    lifetime,
  }
}

/** Records only exact invocation evidence; absent records are unknown, never foreign. */
export function createManagedCommitProvenance(args: {
  file: string
  remote: string
  identity: () => CommitIdentity | null
  subscribed: () => Promise<boolean>
  /** Live synchronous check at the publication linearization point. */
  subscribedNow: () => boolean
}) {
  const remote = canonicalGitHubRemote(args.remote)
  const store = jsonFileStore<ProvenanceFile>(args.file, parse, { mode: 0o600 })

  return {
    async begin(root: string): Promise<unknown> {
      const identity = args.identity()
      if (
        !identity ||
        !Number.isSafeInteger(identity.accountId) ||
        identity.accountId <= 0 ||
        !Number.isSafeInteger(identity.generation) ||
        identity.generation < 0 ||
        !(await args.subscribed())
      )
        return null
      try {
        const repo = await repositoryIdentity(root)
        const origin = await (
          await import('./git')
        ).runGit(root, ['--no-replace-objects', 'remote', 'get-url', 'origin'], {
          executionBudget: { maxBuffer: 65536, timeout: 1000 },
        })
        if (canonicalGitHubRemote(origin) !== remote) return null
        const current = args.identity()
        if (
          !current ||
          current.accountId !== identity.accountId ||
          current.generation !== identity.generation ||
          !(await args.subscribed())
        )
          return null
        return { ...identity, ...repo }
      } catch {
        return null
      }
    },
    async record(ticket: unknown, root: string, oid: string | null): Promise<void> {
      if (!ticket || oid === null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) return
      const started = ticket as CommitIdentity &
        Pick<ProvenanceRecord, 'root' | 'gitDir' | 'device' | 'inode' | 'lifetime'>
      const stillOwned = async () => {
        const identityMatches = () => {
          const current = args.identity()
          return (
            current !== null &&
            current.accountId === started.accountId &&
            current.generation === started.generation
          )
        }
        if (!identityMatches() || !(await args.subscribed())) return false
        const [latest, origin, subscribed] = await Promise.all([
          repositoryIdentity(root).catch(() => null),
          (async () => {
            try {
              return await (
                await import('./git')
              ).runGit(root, ['--no-replace-objects', 'remote', 'get-url', 'origin'], {
                executionBudget: { maxBuffer: 65536, timeout: 1000 },
              })
            } catch {
              return ''
            }
          })(),
          args.subscribed(),
        ])
        if (!subscribed || !identityMatches() || latest === null) return false
        let matchesRemote = false
        try {
          matchesRemote = canonicalGitHubRemote(origin) === remote
        } catch {
          matchesRemote = false
        }
        if (!matchesRemote) return false
        return (
          identityMatches() &&
          JSON.stringify(latest) ===
            JSON.stringify({
              root: started.root,
              gitDir: started.gitDir,
              device: started.device,
              inode: started.inode,
              lifetime: started.lifetime,
            })
        )
      }
      if (!(await stillOwned())) return
      let now: Awaited<ReturnType<typeof repositoryIdentity>>
      try {
        now = await repositoryIdentity(root)
      } catch {
        return
      }
      if (
        JSON.stringify(now) !==
        JSON.stringify({
          root: started.root,
          gitDir: started.gitDir,
          device: started.device,
          inode: started.inode,
          lifetime: started.lifetime,
        })
      )
        return
      await store.update(
        (state) => {
          const key = provenanceKey({ remote, ...now, oid })
          const existing = state.records.find((record) => provenanceKey(record) === key)
          if (existing) {
            if (existing.conflicted) return state
            if (
              existing.accountId === started.accountId &&
              existing.generation === started.generation
            )
              return state
            return {
              version: 1,
              records: state.records.map((record) =>
                record === existing ? { remote, ...now, oid, conflicted: true } : record,
              ),
            }
          }
          if (state.records.length >= 10000)
            throw new Error('Managed commit provenance capacity reached.')
          return {
            version: 1,
            records: [
              ...state.records,
              {
                remote,
                ...now,
                oid,
                accountId: started.accountId,
                generation: started.generation,
              },
            ],
          }
        },
        stillOwned,
        () => {
          // No await between these current observations and the atomic rename.
          // The two local Git queries are bounded: configuration indirection and
          // worktrees must be resolved by Git, not a partial config parser.
          try {
            const current = args.identity()
            if (
              !current ||
              current.accountId !== started.accountId ||
              current.generation !== started.generation
            )
              return false
            const git = (command: string[]) =>
              execFileSync('git', ['--no-replace-objects', ...command], {
                cwd: root,
                encoding: 'utf8',
                timeout: 250,
                maxBuffer: 65536,
                env: {
                  ...process.env,
                  LC_ALL: 'C',
                  GIT_NO_REPLACE_OBJECTS: '1',
                  GIT_TERMINAL_PROMPT: '0',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
              }).trim()
            if (canonicalGitHubRemote(git(['remote', 'get-url', 'origin'])) !== remote) return false
            const gitDir = realpathSync(git(['rev-parse', '--absolute-git-dir']))
            const info = statSync(gitDir)
            return (
              realpathSync(root) === started.root &&
              gitDir === started.gitDir &&
              Number(info.dev) === started.device &&
              Number(info.ino) === started.inode &&
              readFileSync(`${gitDir}/holi-managed-provenance-id`, 'utf8').trim() ===
                started.lifetime &&
              args.subscribedNow()
            )
          } catch {
            return false
          }
        },
      )
    },
  }
}
