import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
  const relativeExecutable = executable.slice(directory.length + 1)
  if (!relativeExecutable || relativeExecutable.startsWith('..'))
    throw new Error('Codex executable is outside its package')
  return {
    package: manifest.name,
    version: manifest.version,
    packageDirectory: directory,
    executable,
    packageJsonSha256: sha256(readFileSync(join(directory, 'package.json'))),
    executableSha256: sha256(readFileSync(executable)),
  }
}
