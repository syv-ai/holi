import { execFile } from 'node:child_process'
import { access, chmod, constants, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** The typst version Holi targets. Templates are authored against it, and the
 * download-on-first-use path (see ensureTypst) pins to it. */
export const TYPST_VERSION = '0.14.1'

export interface ResolveTypstOpts {
  /** Where a downloaded binary is cached (userData/typst). Omitted in tests that
   *  only exercise the PATH branch; wired up in the download task. */
  cacheDir?: string
}

/**
 * Absolute path to a usable typst binary, or null. Resolution order:
 *   1. `TYPST_BIN` env override (tests, power users, the agent front door).
 *   2. a cached download under `cacheDir` (added in the download-on-first-use task).
 *   3. `PATH` (dev — `which typst`).
 * This finds an EXISTING binary only; `ensureTypst` adds the download.
 */
export async function resolveTypstBin(opts: ResolveTypstOpts = {}): Promise<string | null> {
  const override = process.env.TYPST_BIN
  if (override) return override
  if (opts.cacheDir) {
    const cached = cachedBinPath(opts.cacheDir)
    if (await isExecutable(cached)) return cached
  }
  return onPath()
}

/** `typst` on `PATH`, or null. `which` on unix, `where` on Windows. */
export async function onPath(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await exec(cmd, ['typst'])
    const first = stdout.split(/\r?\n/).find((l) => l.trim() !== '')
    return first?.trim() ?? null
  } catch {
    return null
  }
}

export interface TypstAsset {
  /** GitHub release asset filename. */
  archive: string
  /** Path of the binary inside the extracted archive. */
  binInArchive: string
  /** Archive format — decides the extractor. */
  format: 'tar.xz' | 'zip'
}

const TARGETS: Record<string, { triple: string; format: 'tar.xz' | 'zip' }> = {
  'darwin/arm64': { triple: 'aarch64-apple-darwin', format: 'tar.xz' },
  'darwin/x64': { triple: 'x86_64-apple-darwin', format: 'tar.xz' },
  'linux/x64': { triple: 'x86_64-unknown-linux-musl', format: 'tar.xz' },
  'linux/arm64': { triple: 'aarch64-unknown-linux-musl', format: 'tar.xz' },
  'win32/x64': { triple: 'x86_64-pc-windows-msvc', format: 'zip' },
}

/** The release asset for a platform/arch, or throw if typst ships none. */
export function typstReleaseAsset(platform: string, arch: string): TypstAsset {
  const target = TARGETS[`${platform}/${arch}`]
  if (target === undefined) throw new Error(`no typst release for ${platform}/${arch}`)
  const dir = `typst-${target.triple}`
  const bin = platform === 'win32' ? 'typst.exe' : 'typst'
  return { archive: `${dir}.${target.format}`, binInArchive: `${dir}/${bin}`, format: target.format }
}

/** The pinned GitHub release download URL for an asset. */
export function typstDownloadUrl(asset: TypstAsset, version = TYPST_VERSION): string {
  return `https://github.com/typst/typst/releases/download/v${version}/${asset.archive}`
}

/** Where the downloaded binary is cached. Versioned, so bumping the pin lands in
 *  a fresh dir and never runs a stale binary. */
export function cachedBinPath(cacheDir: string): string {
  const bin = process.platform === 'win32' ? 'typst.exe' : 'typst'
  return join(cacheDir, `typst-${TYPST_VERSION}`, bin)
}

async function isExecutable(p: string): Promise<boolean> {
  return access(p, constants.X_OK).then(
    () => true,
    () => false,
  )
}

/**
 * Like `resolveTypstBin`, but downloads-on-first-use: if nothing is found and a
 * `cacheDir` is given, fetch + cache the pinned release for the host platform.
 * Returns null if the download/extraction/verification fails (the UI surfaces a
 * clear "typst is not available" error). Network + extraction are NOT unit-
 * tested here (a 30 MB fetch) — the pure helpers above are, and the end-to-end
 * download is verified manually until a packaged build exists.
 */
export async function ensureTypst(opts: ResolveTypstOpts = {}): Promise<string | null> {
  const existing = await resolveTypstBin(opts)
  if (existing !== null) return existing
  if (!opts.cacheDir) return null
  return downloadTypst(opts.cacheDir)
}

async function downloadTypst(cacheDir: string): Promise<string | null> {
  const asset = typstReleaseAsset(process.platform, process.arch)
  const scratch = await mkdtemp(join(tmpdir(), 'holi-typst-dl-'))
  try {
    const res = await fetch(typstDownloadUrl(asset))
    if (!res.ok) return null
    const archivePath = join(scratch, asset.archive)
    await writeFile(archivePath, Buffer.from(await res.arrayBuffer()))
    await extract(archivePath, scratch, asset.format)

    const dest = cachedBinPath(cacheDir)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(scratch, asset.binInArchive), dest)
    await chmod(dest, 0o755)

    // Functional integrity check: it runs and reports the pinned version.
    // (A sha256 pin of the archive is the stronger check — see the spec's open
    // questions; deferred so we don't maintain a per-platform checksum table.)
    const { stdout } = await exec(dest, ['--version'])
    if (!stdout.includes(TYPST_VERSION)) {
      await rm(dest, { force: true })
      return null
    }
    return dest
  } catch {
    return null
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Extract a typst release archive. `tar` autodetects xz on macOS/Linux;
 *  Windows uses PowerShell's Expand-Archive. Windows is unverified until a
 *  packaged build exists (spec open question). */
async function extract(archivePath: string, into: string, format: 'tar.xz' | 'zip'): Promise<void> {
  if (format === 'zip') {
    await exec('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path "${archivePath}" -DestinationPath "${into}" -Force`,
    ])
  } else {
    await exec('tar', ['-xf', archivePath, '-C', into])
  }
}
