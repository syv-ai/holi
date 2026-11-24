import { open, realpath, stat } from 'node:fs/promises'
import { constants, realpathSync, statSync } from 'node:fs'
import { join, posix, dirname } from 'node:path'
import { exactPath } from '@holi/shared/path-safety-node'
import {
  isAgentSurfacePath,
  isLocalOnlyPath,
  isSecretPath,
  vaultRelPath,
  type MdxDiagnostic,
} from '@holi/shared'
import { MdxExternalDataError } from './mdx-external-data'
import type { MdxResourceOwner, MdxInspectResult } from './mdx-resources'

const FILE_LIMIT = 256 * 1024
const TOTAL_LIMIT = 1024 * 1024
const MODULE_LIMIT = 64
const DEPTH_LIMIT = 16
const REQUEST_LIMIT = 10_000

type ModuleFormat = 'mdx' | 'jsx' | 'js'

// Explicit HTTPS is the only network entry point. Remote children can name
// same-origin relative URLs, but never resolve to a vault path or a package.
function relativeUrl(specifier: string): boolean {
  return /^(?:\.\.?\/|\/(?!\/))/.test(specifier)
}

function remoteFormat(url: URL): ModuleFormat | null {
  const file = posix.basename(url.pathname)
  const ext = posix.extname(file).toLowerCase()
  if (ext === '.jsx') return 'jsx'
  if (!ext || ext === '.js' || ext === '.mjs') return 'js'
  return null
}

export async function inspectMdxDependencies(options: {
  root: string
  path: string
  source: string
  signal: AbortSignal
  assertCurrent(): Promise<void>
  owner: MdxResourceOwner
  external?: {
    fetch(
      url: string,
      signal: AbortSignal,
      localTreeCurrent: () => boolean,
    ): Promise<{ url: string; text: string }>
    retainSnapshot(localTreeCurrent: () => boolean): void
  }
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
  try {
    if (options.signal.aborted) throw options.signal.reason ?? new Error('MDX compile superseded')
    const check = async () => {
      if (signal.aborted) throw signal.reason ?? new Error('MDX compile superseded')
      await options.assertCurrent()
      if (signal.aborted) throw signal.reason ?? new Error('MDX compile superseded')
    }
    const completed = new Set<string>(),
      active = new Set<string>()
    const snapshots = new Map<string, string>()
    const ancestors = new Map<string, string>()
    const redirects = new Map<string, string>()
    let remoteAttempts = 0
    let readBudget = TOTAL_LIMIT - Buffer.byteLength(options.source)
    let total = 0,
      count = 0
    const rootCanonical = await realpath(options.root)
    const id = (s: { dev: number | bigint; ino: number | bigint }) => `${s.dev}:${s.ino}`
    const fileId = (s: {
      dev: number | bigint
      ino: number | bigint
      size: number
      mtimeMs: number
      ctimeMs: number
    }) => `${id(s)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
    const rootStat = await stat(rootCanonical)
    const rootIdentity = id(rootStat)
    const validateRootAndAncestors = async () => {
      if (
        (await realpath(options.root)) !== rootCanonical ||
        id(await stat(rootCanonical)) !== rootIdentity
      )
        throw new Error('Vault root changed during MDX inspection')
      for (const [path, expected] of ancestors) {
        if ((await realpath(path)) !== path || id(await stat(path)) !== expected)
          throw new Error('Dependency ancestor changed during MDX inspection')
      }
    }
    const validateTree = async () => {
      await validateRootAndAncestors()
      for (const [path, expected] of snapshots) {
        const target = join(rootCanonical, path)
        if (
          (await exactPath(rootCanonical, path)) !== target ||
          fileId(await stat(target)) !== expected
        )
          throw new Error(`Dependency ${path} changed during inspection`)
        let parent = dirname(target)
        while (parent !== rootCanonical) {
          if ((await realpath(parent)) !== parent)
            throw new Error('Dependency ancestor changed during MDX inspection')
          parent = dirname(parent)
        }
      }
    }
    // The consent store's atomic publication guard cannot await filesystem I/O.
    const localTreeCurrent = () => {
      try {
        return (
          realpathSync(options.root) === rootCanonical &&
          id(statSync(rootCanonical)) === rootIdentity &&
          [...ancestors].every(
            ([path, expected]) => realpathSync(path) === path && id(statSync(path)) === expected,
          ) &&
          [...snapshots].every(([path, expected]) => {
            const target = join(rootCanonical, path)
            return realpathSync(target) === target && fileId(statSync(target)) === expected
          })
        )
      } catch {
        return false
      }
    }
    const safePolicy = (path: string) =>
      [path, path.toLowerCase()].every(
        (p) => !isSecretPath(p) && !isLocalOnlyPath(p) && !isAgentSurfacePath(p),
      )
    const failure = (message: string, line: number): MdxDiagnostic => ({
      message,
      line: Math.max(1, line),
      column: 1,
    })
    const visit = async (
      path: string,
      source: string,
      format: ModuleFormat,
      depth: number,
      remote?: URL,
    ): Promise<MdxDiagnostic[]> => {
      await check()
      const safe = remote ? remote.origin : vaultRelPath(path)
      const key = remote?.href ?? safe
      if (!remote && !safePolicy(safe))
        return [failure(`Dependency ${safe} is protected or unavailable`, 1)]
      if (active.has(key)) return [failure(`Dependency cycle involving ${safe}`, 1)]
      if (completed.has(key)) return []
      if (depth > DEPTH_LIMIT || (!remote && count >= MODULE_LIMIT))
        return [failure(`Dependency graph limit reached at ${safe}`, 1)]
      const size = Buffer.byteLength(source)
      if (size > FILE_LIMIT || total + size > TOTAL_LIMIT)
        return [failure(`Dependency size limit reached at ${safe}`, 1)]
      if (!remote) count++
      total += size
      active.add(key)
      try {
        await check()
        await validateRootAndAncestors()
        const result = await options.inspect(options.owner, source, signal, format)
        await check()
        const diagnostics = [...result.diagnostics]
        for (const dep of result.dependencies) {
          await check()
          const line = dep.line ?? 1,
            spec = dep.specifier
          const absolute = /^https:\/\//i.test(spec)
          if (remote || absolute) {
            let target: URL
            try {
              if (
                (!absolute && (!remote || !relativeUrl(spec))) ||
                /[\s\\\u0000-\u001f\u007f]/u.test(spec)
              )
                throw new Error('unsupported dependency')
              target = new URL(spec, remote)
              target.hash = ''
              if (!remoteFormat(target)) throw new Error('unsupported dependency')
            } catch {
              diagnostics.push(failure('Unsupported external MDX module specifier', line))
              continue
            }
            const resolved = redirects.get(target.href) ?? target.href
            if (active.has(resolved)) {
              diagnostics.push(failure(`Dependency cycle involving ${target.origin}`, line))
              continue
            }
            if (completed.has(resolved)) continue
            if (!options.external) {
              diagnostics.push(failure('External MDX dependency access is unavailable', line))
              continue
            }
            // Reserve the fetcher's maximum body size before contacting a server.
            // Failed/aliased fetches also consume a graph slot, not just parsed modules.
            if (depth + 1 > DEPTH_LIMIT || count >= MODULE_LIMIT || readBudget < FILE_LIMIT) {
              diagnostics.push(failure(`Dependency graph limit reached at ${target.origin}`, line))
              continue
            }
            count++
            remoteAttempts++
            let fetched: { url: string; text: string }
            try {
              // Let the fetcher validate the raw absolute URL; URL parsing alone silently repairs it.
              fetched = await options.external.fetch(
                absolute ? spec : target.href,
                signal,
                localTreeCurrent,
              )
            } catch (error) {
              await check()
              diagnostics.push(
                failure(
                  error instanceof MdxExternalDataError
                    ? error.message
                    : 'External MDX dependency access is unavailable',
                  line,
                ),
              )
              // A partial failed response has no trusted byte count.
              if (!(error instanceof MdxExternalDataError && error.code === 'consent-needed'))
                readBudget -= FILE_LIMIT
              continue
            }
            await check()
            const final = new URL(fetched.url)
            const childFormat = remoteFormat(final)
            readBudget -= Math.min(FILE_LIMIT, Buffer.byteLength(fetched.text) + 3) // Possible UTF-8 BOM.
            if (!childFormat) {
              diagnostics.push(failure('Unsupported external MDX module destination', line))
              continue
            }
            redirects.set(target.href, final.href)
            diagnostics.push(
              ...(await visit(final.href, fetched.text, childFormat, depth + 1, final)).map(
                (d) => ({
                  ...d,
                  message: `${final.origin}:${d.line}:${d.column}: ${d.message}`,
                  line,
                }),
              ),
            )
            continue
          }
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
          if (active.has(child)) {
            diagnostics.push(failure(`Dependency cycle involving ${child}`, line))
            continue
          }
          if (completed.has(child)) continue
          if (
            depth + 1 > DEPTH_LIMIT ||
            count >= MODULE_LIMIT ||
            total + 1 > TOTAL_LIMIT ||
            readBudget <= 0
          ) {
            diagnostics.push(failure(`Dependency graph limit reached at ${child}`, line))
            break
          }
          const target = join(rootCanonical, child)
          let text = ''
          try {
            await check()
            if ((await exactPath(rootCanonical, child)) !== target) throw new Error('unsafe path')
            await validateRootAndAncestors()
            let parent = dirname(target)
            while (parent !== rootCanonical) {
              if ((await realpath(parent)) !== parent) throw new Error('unsafe ancestor')
              const identity = id(await stat(parent))
              if (ancestors.has(parent) && ancestors.get(parent) !== identity)
                throw new Error('changed ancestor')
              ancestors.set(parent, identity)
              parent = dirname(parent)
            }
            await check()
            await validateRootAndAncestors()
            const handle = await open(
              target,
              constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
            )
            try {
              const before = await handle.stat()
              if (
                !before.isFile() ||
                before.nlink !== 1 ||
                id(before) !== id(await stat(target)) ||
                (await realpath(target)) !== target
              )
                throw new Error('unsafe identity')
              const remaining = Math.min(FILE_LIMIT, TOTAL_LIMIT - total, readBudget)
              if (before.size > remaining) {
                if (before.size > readBudget) readBudget = 0
                throw new Error('size limit')
              }
              snapshots.set(child, fileId(before))
              await check()
              const chunks: Buffer[] = []
              let bytes = 0
              const buffer = Buffer.alloc(16 * 1024)
              while (bytes <= remaining) {
                await check()
                const n = await handle.read(
                  buffer,
                  0,
                  Math.min(buffer.length, remaining + 1 - bytes),
                  bytes,
                )
                if (!n.bytesRead) break
                readBudget -= n.bytesRead
                chunks.push(Buffer.from(buffer.subarray(0, n.bytesRead)))
                bytes += n.bytesRead
              }
              if (bytes > remaining) throw new Error('size limit')
              if (
                fileId(await handle.stat()) !== fileId(before) ||
                fileId(await stat(target)) !== fileId(before) ||
                (await exactPath(rootCanonical, child)) !== target
              )
                throw new Error('changed')
              text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
              await check()
            } finally {
              await handle.close()
            }
          } catch {
            await check()
            diagnostics.push(failure(`Dependency ${child} could not be safely read`, line))
            continue
          }
          diagnostics.push(
            ...(await visit(child, text, ext as ModuleFormat, depth + 1)).map((d) => ({
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
    const result = await visit(options.path, options.source, 'mdx', 0)
    await check()
    await validateTree()
    await check()
    if (remoteAttempts > 0) options.external?.retainSnapshot(localTreeCurrent)
    return result
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
  }
}
