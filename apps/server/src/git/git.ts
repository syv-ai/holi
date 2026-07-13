/** Thin git-CLI wrapper. All git I/O in the codebase goes through here so the
 * ssh environment (deploy keys) and error handling live in one place. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MAX_BUFFER = 64 * 1024 * 1024

export type GitEnv = Record<string, string>

/** Run git, return stdout with the single trailing newline stripped. */
export async function git(args: string[], cwd: string, env?: GitEnv): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...env },
  })
  return stdout.replace(/\n$/, '')
}

/** Run git, return raw stdout bytes (exact file contents for `show`). */
export async function gitBuffer(args: string[], cwd: string, env?: GitEnv): Promise<Buffer> {
  const { stdout } = await run('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, ...env },
    encoding: 'buffer',
  })
  return stdout
}

export async function tryGit(
  args: string[],
  cwd: string,
  env?: GitEnv,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    return { ok: true, stdout: await git(args, cwd, env) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const res = await tryGit(['merge-base', '--is-ancestor', ancestor, descendant], cwd)
  return res.ok
}

export interface NameStatusEntry {
  status: 'A' | 'M' | 'D' | 'R'
  path: string
  oldPath?: string
  similarity?: number
}

/** Parse `git diff --name-status -M -z` output (NUL-separated). */
export function parseNameStatusZ(out: string): NameStatusEntry[] {
  const fields = out.split('\0').filter((f) => f.length > 0)
  const entries: NameStatusEntry[] = []
  let i = 0
  while (i < fields.length) {
    const code = fields[i]!
    if (code.startsWith('R') || code.startsWith('C')) {
      // copies (C) are treated as adds of the new path
      const oldPath = fields[i + 1]!
      const path = fields[i + 2]!
      if (code.startsWith('R')) {
        entries.push({ status: 'R', path, oldPath, similarity: Number(code.slice(1)) || undefined })
      } else {
        entries.push({ status: 'A', path })
      }
      i += 3
    } else if (code === 'A' || code === 'M' || code === 'D' || code === 'T') {
      // type changes (T) are content changes for our purposes
      entries.push({ status: code === 'T' ? 'M' : code, path: fields[i + 1]! })
      i += 2
    } else {
      // unmerged (U) etc. cannot occur on a plain two-commit diff — skip defensively
      i += 2
    }
  }
  return entries
}
