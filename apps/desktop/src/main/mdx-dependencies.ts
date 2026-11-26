import { open, realpath, stat } from 'node:fs/promises'
import { constants, realpathSync, statSync } from 'node:fs'
import { join, posix, dirname } from 'node:path'
import { exactPath } from '@holi/shared/path-safety-node'
import {
  MAX_MDX_ARTIFACT_BYTES,
  MAX_MDX_ARTIFACT_GRAPH_BYTES,
  type MdxArtifactModule,
  isAgentSurfacePath,
  isLocalOnlyPath,
  isMachineStatePath,
  isSecretPath,
  vaultRelPath,
  type MdxDiagnostic,
} from '@holi/shared'
import { MdxExternalDataError } from './mdx-external-data'
import { resolveMdxExternalResource } from './mdx-external-policy'
import { inspectMdxCssResources } from './mdx-css-resources'
import type { MdxExternalResourceKind } from './mdx-external-policy'
import type { MdxResourceOwner, MdxInspectResult } from './mdx-resources'

const FILE_LIMIT = 256 * 1024
const TOTAL_LIMIT = 1024 * 1024
const MODULE_LIMIT = 64
const DEPTH_LIMIT = 16
const REQUEST_LIMIT = 10_000
const ASSET_SUFFIX = /\.(?:png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i

type ModuleFormat = 'mdx' | 'jsx' | 'js' | 'css' | 'asset'
type RemoteProvenance = {
  hops: Set<string>
  parents: Set<RemoteProvenance>
}

// Explicit HTTPS is the only network entry point. Remote children can name
// same-origin relative URLs, but never resolve to a vault path or a package.
function relativeUrl(specifier: string): boolean {
  return /^(?:\.\.?\/|\/(?!\/))/.test(specifier)
}

export interface MdxDependencyOptions {
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
      // Collects authorized hops for this fetch. For a consent discovery, the graph
      // adds inherited origins to the same set before inspection returns.
      discoveryOrigins: Set<string>,
      kind?: MdxExternalResourceKind,
    ): Promise<{ url: string; text?: string; bytes?: Uint8Array }>
    retainSnapshot(localTreeCurrent: () => boolean): void
  }
  inspect(
    owner: MdxResourceOwner,
    source: string,
    signal: AbortSignal,
    format: 'mdx' | 'jsx' | 'js',
    options?: { emitArtifact?: boolean },
  ): Promise<MdxInspectResult>
}

export interface MdxCompiledDependencies {
  diagnostics: MdxDiagnostic[]
  modules: MdxArtifactModule[]
  current(): boolean
}

export async function inspectMdxDependencies(
  options: MdxDependencyOptions,
): Promise<MdxDiagnostic[]> {
  return (await inspectGraph(options, false)).diagnostics
}

export function compileMdxDependencies(
  options: Omit<MdxDependencyOptions, 'external'>,
): Promise<MdxCompiledDependencies> {
  return inspectGraph({ ...options, external: undefined }, true)
}

async function inspectGraph(
  options: MdxDependencyOptions,
  emitArtifacts: boolean,
): Promise<MdxCompiledDependencies> {
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
    const provenance = new Map<string, RemoteProvenance>()
    const discoveries: { from: RemoteProvenance; origins: Set<string> }[] = []
    const recordRemotePath = (
      url: string,
      from?: RemoteProvenance,
      hops?: ReadonlySet<string>,
    ): RemoteProvenance => {
      const node: RemoteProvenance = provenance.get(url) ?? { hops: new Set(), parents: new Set() }
      if (from) node.parents.add(from)
      for (const hop of hops ?? []) node.hops.add(hop)
      provenance.set(url, node)
      return node
    }
    const modules: MdxArtifactModule[] = []
    let artifactBytes = 0
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
        (p) =>
          !isSecretPath(p) &&
          !isLocalOnlyPath(p) &&
          !isAgentSurfacePath(p) &&
          !isMachineStatePath(p),
      )
    const failure = (message: string, line: number, column = 1): MdxDiagnostic => ({
      message,
      line: Math.max(1, line),
      column: Math.max(1, column),
    })
    const visit = async (
      path: string,
      source: string | Uint8Array,
      format: ModuleFormat,
      depth: number,
      remote?: { url: URL; provenance: RemoteProvenance },
    ): Promise<MdxDiagnostic[]> => {
      await check()
      const safe = remote ? remote.url.origin : vaultRelPath(path)
      const key = remote?.url.href ?? safe
      if (!remote && !safePolicy(safe))
        return [failure(`Dependency ${safe} is protected or unavailable`, 1)]
      if (active.has(key)) return [failure(`Dependency cycle involving ${safe}`, 1)]
      if (completed.has(key)) return []
      if (depth > DEPTH_LIMIT || (!remote && count >= MODULE_LIMIT))
        return [failure(`Dependency graph limit reached at ${safe}`, 1)]
      const size = typeof source === 'string' ? Buffer.byteLength(source) : source.byteLength
      if (size > FILE_LIMIT || total + size > TOTAL_LIMIT)
        return [failure(`Dependency size limit reached at ${safe}`, 1)]
      if (!remote) count++
      total += size
      active.add(key)
      try {
        await check()
        await validateRootAndAncestors()
        if (format === 'asset') {
          completed.add(key)
          return []
        }
        if (typeof source !== 'string')
          return [failure(`Dependency ${safe} has no readable source`, 1)]
        const result =
          format === 'css'
            ? inspectMdxCssResources(source)
            : await options.inspect(options.owner, source, signal, format, {
                emitArtifact: emitArtifacts,
              })
        await check()
        const diagnostics = [...result.diagnostics]
        const imports: MdxArtifactModule['imports'] = Object.create(null)
        if (emitArtifacts && diagnostics.length === 0) {
          const artifact = 'artifact' in result ? result.artifact : undefined
          if (typeof artifact !== 'string') {
            diagnostics.push(failure('Compiled module is unavailable', 1))
          } else {
            artifactBytes += Buffer.byteLength(artifact, 'utf8')
            if (artifactBytes > MAX_MDX_ARTIFACT_BYTES)
              diagnostics.push(failure('Compiled module graph exceeds its size limit', 1))
            else modules.push({ path: safe, code: artifact, imports })
          }
        }
        for (const dep of result.dependencies) {
          await check()
          const line = dep.line ?? 1,
            spec = dep.specifier
          if (emitArtifacts && (spec === 'react' || spec === 'react/jsx-runtime')) {
            imports[spec] = { runtime: spec }
            continue
          }
          const resourcePath = spec.split(/[?#]/, 1)[0] ?? ''
          const kind: MdxExternalResourceKind =
            'kind' in dep && (dep.kind === 'css' || dep.kind === 'asset')
              ? dep.kind
              : /\.css$/i.test(resourcePath)
                ? 'css'
                : ASSET_SUFFIX.test(resourcePath)
                  ? 'asset'
                  : 'module'
          const absolute = /^https:\/\//i.test(spec)
          if (emitArtifacts && (absolute || kind !== 'module')) {
            diagnostics.push(
              failure(
                'Only local ECMAScript modules are available for compilation',
                line,
                dep.column,
              ),
            )
            continue
          }
          if (remote || absolute) {
            // Validate the raw spelling before consulting either canonical graph cache.
            const destination =
              absolute || (remote && (format === 'css' || relativeUrl(spec)))
                ? resolveMdxExternalResource(spec, kind, remote?.url)
                : null
            if (!destination || 'error' in destination) {
              diagnostics.push(
                failure('Unsupported external MDX module specifier', line, dep.column),
              )
              continue
            }
            const target = destination.url
            const resolved = redirects.get(target.href) ?? target.href
            const cycle = active.has(resolved)
            if (cycle || completed.has(resolved)) {
              recordRemotePath(resolved, remote?.provenance)
              if (cycle)
                diagnostics.push(
                  failure(`Dependency cycle involving ${target.origin}`, line, dep.column),
                )
              continue
            }
            if (!options.external) {
              diagnostics.push(
                failure('External MDX dependency access is unavailable', line, dep.column),
              )
              continue
            }
            // Reserve the fetcher's maximum body size before contacting a server.
            // Failed/aliased fetches also consume a graph slot, not just parsed modules.
            if (depth + 1 > DEPTH_LIMIT || count >= MODULE_LIMIT || readBudget < FILE_LIMIT) {
              diagnostics.push(
                failure(`Dependency graph limit reached at ${target.origin}`, line, dep.column),
              )
              continue
            }
            count++
            remoteAttempts++
            let fetched: { url: string; text?: string; bytes?: Uint8Array }
            const discoveryOrigins = new Set<string>()
            try {
              fetched = await options.external.fetch(
                absolute ? spec : target.href,
                signal,
                localTreeCurrent,
                discoveryOrigins,
                kind,
              )
            } catch (error) {
              await check()
              diagnostics.push(
                failure(
                  error instanceof MdxExternalDataError
                    ? error.message
                    : 'External MDX dependency access is unavailable',
                  line,
                  dep.column,
                ),
              )
              if (error instanceof MdxExternalDataError && error.code === 'consent-needed') {
                if (remote && error.origin)
                  discoveries.push({ from: remote.provenance, origins: discoveryOrigins })
              } else {
                // A partial failed response has no trusted byte count.
                readBudget -= FILE_LIMIT
              }
              continue
            }
            await check()
            const destinationAfterRedirects = resolveMdxExternalResource(fetched.url, kind)
            const data = kind === 'asset' ? fetched.bytes : fetched.text
            if (data === undefined) {
              readBudget -= FILE_LIMIT
              diagnostics.push(
                failure('External MDX resource response is unavailable', line, dep.column),
              )
              continue
            }
            readBudget -= Math.min(
              FILE_LIMIT,
              fetched.bytes?.byteLength ?? Buffer.byteLength(data) + 3,
            )
            if ('error' in destinationAfterRedirects) {
              diagnostics.push(
                failure('Unsupported external MDX module destination', line, dep.column),
              )
              continue
            }
            const { url: final } = destinationAfterRedirects
            const childFormat =
              destinationAfterRedirects.kind === 'module'
                ? destinationAfterRedirects.format
                : destinationAfterRedirects.kind
            redirects.set(target.href, final.href)
            diagnostics.push(
              ...(
                await visit(final.href, data, childFormat, depth + 1, {
                  url: final,
                  provenance: recordRemotePath(final.href, remote?.provenance, discoveryOrigins),
                })
              ).map((d) => ({
                ...d,
                message: `${final.origin}:${d.line}:${d.column}: ${d.message}`,
                line,
                column: dep.column ?? 1,
              })),
            )
            continue
          }
          const ext = kind === 'module' ? spec.match(/\.(mdx|jsx|js)$/i)?.[1]?.toLowerCase() : kind
          if (
            (format !== 'css' && !spec.startsWith('./') && !spec.startsWith('../')) ||
            spec.startsWith('/') ||
            /[\\?#]/.test(spec) ||
            /^[a-z][a-z\d+.-]*:/i.test(spec) ||
            (kind === 'asset' && !ASSET_SUFFIX.test(spec)) ||
            (kind === 'css' && !/\.css$/i.test(spec)) ||
            !ext
          ) {
            diagnostics.push(failure('Unsupported local MDX module specifier', line, dep.column))
            continue
          }
          let child: string
          try {
            child = vaultRelPath(posix.normalize(posix.join(posix.dirname(safe), spec)))
          } catch {
            diagnostics.push(failure('Unsupported local MDX module specifier', line, dep.column))
            continue
          }
          if (!safePolicy(child)) {
            diagnostics.push(
              failure(`Dependency ${child} is protected or unavailable`, line, dep.column),
            )
            continue
          }
          if (emitArtifacts) imports[spec] = { path: child }
          if (active.has(child)) {
            diagnostics.push(failure(`Dependency cycle involving ${child}`, line, dep.column))
            continue
          }
          if (completed.has(child)) continue
          if (
            depth + 1 > DEPTH_LIMIT ||
            count >= MODULE_LIMIT ||
            total + 1 > TOTAL_LIMIT ||
            readBudget <= 0
          ) {
            diagnostics.push(
              failure(`Dependency graph limit reached at ${child}`, line, dep.column),
            )
            break
          }
          const target = join(rootCanonical, child)
          let data: string | Uint8Array = ''
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
              const body = Buffer.concat(chunks)
              data =
                kind === 'asset' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body)
              await check()
            } finally {
              await handle.close()
            }
          } catch {
            await check()
            diagnostics.push(
              failure(`Dependency ${child} could not be safely read`, line, dep.column),
            )
            continue
          }
          diagnostics.push(
            ...(await visit(child, data, ext as ModuleFormat, depth + 1)).map((d) => ({
              ...d,
              message: `${child}:${d.line}:${d.column}: ${d.message}`,
              line,
              column: dep.column ?? 1,
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
    // An earlier traversal may have discovered consent before another path to the
    // same canonical module was visited. Walk the recorded paths, not the network.
    for (const { from, origins } of discoveries) {
      const seen = new Set<RemoteProvenance>()
      const upstream = [from]
      while (upstream.length) {
        const node = upstream.pop()!
        if (seen.has(node)) continue
        seen.add(node)
        for (const hop of node.hops) origins.add(hop)
        for (const parent of node.parents) upstream.push(parent)
      }
    }
    if (remoteAttempts > 0) options.external?.retainSnapshot(localTreeCurrent)
    if (
      emitArtifacts &&
      Buffer.byteLength(JSON.stringify(modules), 'utf8') > MAX_MDX_ARTIFACT_GRAPH_BYTES
    )
      result.push(failure('Compiled module graph exceeds its transport limit', 1))
    if (emitArtifacts && !localTreeCurrent()) throw new Error('MDX dependency graph changed')
    return {
      diagnostics: result,
      modules: result.length === 0 ? modules : [],
      current: localTreeCurrent,
    }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', abort)
  }
}
