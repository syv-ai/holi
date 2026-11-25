import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'

export const reviewedCodexTuiRelease = Object.freeze({
  package: '@openai/codex',
  version: '0.166.0',
})

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Resolve and hash the exact installed Codex package and native executable. */
export function verifyCodexTuiProvenance(bin, expectedVersion = reviewedCodexTuiRelease.version) {
  if (!bin || expectedVersion !== reviewedCodexTuiRelease.version)
    throw new Error('Codex TUI must use the reviewed exact release')
  const executable = realpathSync(bin)
  let directory = dirname(executable)
  let manifest
  for (let depth = 0; depth < 12; depth++) {
    try {
      const candidate = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (candidate.name === reviewedCodexTuiRelease.package) {
        manifest = candidate
        break
      }
    } catch {}
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  if (!manifest || manifest.version !== expectedVersion)
    throw new Error('Codex package provenance or version mismatch')
  const relativeExecutable = relative(directory, executable)
  if (!relativeExecutable || relativeExecutable.startsWith('..') || isAbsolute(relativeExecutable))
    throw new Error('Codex executable is outside its package')

  // Codex ships a JS launcher as well as the platform binary. Provenance for
  // native acceptance must bind to the latter, not merely the npm wrapper.
  const bytes = readFileSync(executable)
  const magic = bytes.subarray(0, 4).toString('hex')
  const nativeFormat = new Map([
    ['cffaedfe', 'macho'],
    ['feedfacf', 'macho'],
    ['cafebabe', 'macho'],
    ['7f454c46', 'elf'],
  ]).get(magic)
  if (!nativeFormat) throw new Error('Codex executable is not a native Mach-O or ELF binary')
  const observedVersion = execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (
    !new RegExp(`^codex ${expectedVersion.replaceAll('.', '\\\\.')}(?:\\\\s|$)`, 'i').test(
      observedVersion,
    )
  )
    throw new Error(`Codex runtime version mismatch: ${observedVersion}`)
  return {
    package: manifest.name,
    version: manifest.version,
    packageDirectory: directory,
    executable,
    nativeFormat,
    observedVersion,
    packageJsonSha256: sha256(readFileSync(join(directory, 'package.json'))),
    executableSha256: sha256(bytes),
  }
}
