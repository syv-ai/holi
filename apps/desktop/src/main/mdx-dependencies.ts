import { open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, posix } from 'node:path'
import { exactPath } from '@holi/shared/path-safety-node'
import {
  isAgentSurfacePath,
  isLocalOnlyPath,
  isSecretPath,
  vaultRelPath,
  type MdxDiagnostic,
} from '@holi/shared'
import type { MdxResourceOwner, MdxInspectResult } from './mdx-resources'

const FILE_LIMIT = 256 * 1024
const TOTAL_LIMIT = 1024 * 1024
const MODULE_LIMIT = 64
const DEPTH_LIMIT = 16
const REQUEST_LIMIT = 10_000

export async function inspectMdxDependencies(options: {
  root: string
  path: string
  source: string
  signal: AbortSignal
  assertCurrent(): Promise<void>
  owner: MdxResourceOwner
  inspect(
    owner: MdxResourceOwner,
    source: string,
    signal: AbortSignal,
    format: 'mdx' | 'jsx' | 'js',
  ): Promise<MdxInspectResult>
}): Promise<MdxDiagnostic[]> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('MDX dependency inspection timed out')),
    REQUEST_LIMIT,
  )
  const abort = () => controller.abort(options.signal.reason)
  options.signal.addEventListener('abort', abort, { once: true })
  const signal = controller.signal
  const check = async () => {
    if (signal.aborted) throw signal.reason ?? new Error('MDX compile superseded')
    await options.assertCurrent()
    if (signal.aborted) throw signal.reason ?? new Error('MDX compile superseded')
  }
  const completed = new Set<string>()
  const active = new Set<string>()
  const snapshots = new Map<string, string>()
  let total = 0
  let count = 0
  const rootCanonical = await realpath(options.root)
  const rootStat = await stat(rootCanonical)
  const identity = (s: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>) =>
    `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
  const rootIdentity = identity(rootStat)
  const validateRoot = async () => {
    if (
      (await realpath(options.root)) !== rootCanonical ||
      identity(await stat(rootCanonical)) !== rootIdentity
    )
      throw new Error('Vault root changed during MDX inspection')
  }
  const safePolicy = (path: string) => {
    const lower = path.toLowerCase()
    return [path, lower].every(
      (p) => !isSecretPath(p) && !isLocalOnlyPath(p) && !isAgentSurfacePath(p),
    )
  }
  const failure = (message: string, line: number): MdxDiagnostic => ({
    message,
    line: Math.max(1, line),
    column: 1,
  })
  const visit = async (
    path: string,
    source: string,
    format: 'mdx' | 'jsx' | 'js',
    depth: number,
  ): Promise<MdxDiagnostic[]> => {
    await check()
    const safe = vaultRelPath(path)
    if (!safePolicy(safe)) return [failure(`Dependency ${safe} is protected or unavailable`, 1)]
    const key = safe.toLowerCase()
    if (active.has(key)) return [failure(`Dependency cycle involving ${safe}`, 1)]
    if (completed.has(key)) return []
    if (depth > DEPTH_LIMIT || count >= MODULE_LIMIT)
      return [failure(`Dependency graph limit reached at ${safe}`, 1)]
    active.add(key)
    count++
    const size = Buffer.byteLength(source)
    if (size > FILE_LIMIT || total + size > TOTAL_LIMIT) {
      active.delete(key)
      return [failure(`Dependency size limit reached at ${safe}`, 1)]
    }
    total += size
    try {
      const result = await options.inspect(options.owner, source, signal, format)
      await check()
      const diagnostics = [...result.diagnostics]
      for (const dep of result.dependencies) {
        await check()
        const line = dep.line ?? 1
        const spec = dep.specifier
        const ext = spec.match(/\.(mdx|jsx|js)$/i)?.[1]?.toLowerCase()
        if ((!spec.startsWith('./') && !spec.startsWith('../')) || /[?#]/.test(spec) || !ext) {
          diagnostics.push(failure(`Dependency ${spec} is unavailable`, line))
          continue
        }
        let child: string
        try {
          child = vaultRelPath(posix.normalize(posix.join(posix.dirname(safe), spec)))
        } catch {
          diagnostics.push(failure(`Dependency ${spec} is unavailable`, line))
          continue
        }
        if (!safePolicy(child)) {
          diagnostics.push(failure(`Dependency ${child} is protected or unavailable`, line))
          continue
        }
        const canonical = await exactPath(rootCanonical, child).catch(() => null)
        await check()
        const expected = join(rootCanonical, child)
        if (!canonical || canonical !== expected) {
          diagnostics.push(failure(`Dependency ${child} is missing or unsafe`, line))
          continue
        }
        let text: string
        let snap: string
        try {
          const handle = await open(
            canonical,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
          )
          try {
            const fdBefore = await handle.stat()
            const pathBefore = await stat(canonical)
            if (
              !fdBefore.isFile() ||
              fdBefore.nlink !== 1 ||
              identity(fdBefore) !== identity(pathBefore) ||
              (await realpath(canonical)) !== canonical
            )
              throw new Error('unsafe file identity')
            const chunks: Buffer[] = []
            let bytes = 0
            const buffer = Buffer.alloc(16 * 1024)
            while (bytes <= FILE_LIMIT) {
              await check()
              const n = await handle.read(
                buffer,
                0,
                Math.min(buffer.length, FILE_LIMIT + 1 - bytes),
                bytes,
              )
              if (!n.bytesRead) break
              chunks.push(Buffer.from(buffer.subarray(0, n.bytesRead)))
              bytes += n.bytesRead
            }
            if (bytes > FILE_LIMIT) throw new Error('file size limit')
            const after = await handle.stat()
            if (
              identity(after) !== identity(fdBefore) ||
              identity(await stat(canonical)) !== identity(fdBefore) ||
              (await exactPath(rootCanonical, child)) !== canonical
            )
              throw new Error('file changed during read')
            text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
            snap = identity(after)
          } finally {
            await handle.close()
          }
        } catch {
          await check()
          diagnostics.push(failure(`Dependency ${child} could not be safely read`, line))
          continue
        }
        snapshots.set(child, snap)
        diagnostics.push(
          ...(await visit(child, text, ext as 'mdx' | 'jsx' | 'js', depth + 1)).map((d) => ({
            ...d,
            message: `${child}:${d.line}:${d.column}: ${d.message}`,
            line,
          })),
        )
      }
      completed.add(key)
      return diagnostics
    } finally {
      active.delete(key)
    }
  }
  try {
    const result = await visit(options.path, options.source, 'mdx', 0)
    await check()
    await validateRoot()
    for (const [path, expected] of snapshots) {
      await check()
      if (
        (await exactPath(rootCanonical, path)) !== join(rootCanonical, path) ||
        identity(await stat(join(rootCanonical, path))) !== expected
      )
        throw new Error(`Dependency ${path} changed during inspection`)
    }
    return result
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
  }
}
