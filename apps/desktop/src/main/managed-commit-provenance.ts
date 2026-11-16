import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { jsonFileStore } from './json-file-store'
import { canonicalGitHubRemote } from './mdx-trust'

interface ProvenanceRecord {
  remote: string
  root: string
  gitDir: string
  device: number
  inode: number
  oid: string
  accountId: number
  generation: number
}

interface ProvenanceFile {
  version: 1
  records: ProvenanceRecord[]
}

export interface CommitIdentity {
  accountId: number
  generation: number
}

const empty = (): ProvenanceFile => ({ version: 1, records: [] })

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
    remoteIsCanonical &&
    typeof r.root === 'string' &&
    isAbsolute(r.root) &&
    typeof r.gitDir === 'string' &&
    isAbsolute(r.gitDir) &&
    Number.isSafeInteger(r.device) &&
    Number.isSafeInteger(r.inode) &&
    typeof r.oid === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(r.oid) &&
    Number.isSafeInteger(r.accountId) &&
    (r.accountId as number) > 0 &&
    Number.isSafeInteger(r.generation) &&
    (r.generation as number) >= 0
  )
}

async function repositoryIdentity(
  root: string,
): Promise<Pick<ProvenanceRecord, 'root' | 'gitDir' | 'device' | 'inode'>> {
  const canonicalRoot = await realpath(root)
  const gitDirRaw = await (
    await import('./git')
  ).runGit(canonicalRoot, ['rev-parse', '--absolute-git-dir'])
  const gitDir = await realpath(gitDirRaw)
  const gitStat = await stat(gitDir)
  return {
    root: canonicalRoot,
    gitDir,
    device: Number(gitStat.dev),
    inode: Number(gitStat.ino),
  }
}

/** Records only exact invocation evidence; absent records are unknown, never foreign. */
export function createManagedCommitProvenance(args: {
  file: string
  remote: string
  identity: () => CommitIdentity | null
  subscribed: () => Promise<boolean>
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
        !(await args.subscribed())
      )
        return null
      try {
        return { ...identity, ...(await repositoryIdentity(root)) }
      } catch {
        return null
      }
    },
    async record(ticket: unknown, root: string, oid: string | null): Promise<void> {
      if (!ticket || oid === null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(oid)) return
      const started = ticket as CommitIdentity &
        Pick<ProvenanceRecord, 'root' | 'gitDir' | 'device' | 'inode'>
      const current = args.identity()
      if (
        !current ||
        current.accountId !== started.accountId ||
        current.generation !== started.generation ||
        !(await args.subscribed())
      )
        return
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
        })
      )
        return
      await store.update((state) => {
        const existing = state.records.find(
          (r) =>
            r.remote === remote &&
            r.root === now.root &&
            r.gitDir === now.gitDir &&
            r.inode === now.inode &&
            r.oid === oid,
        )
        if (existing) {
          if (
            existing.accountId !== started.accountId ||
            existing.generation !== started.generation
          )
            throw new Error('Conflicting managed commit provenance; record left unchanged.')
          return state
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
      })
    },
  }
}
