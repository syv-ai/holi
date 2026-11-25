import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'

export const reviewedCodexTuiRelease = Object.freeze({
  package: '@openai/codex',
  version: '0.166.0',
})

/** Bind an owned npm installation to its exact launcher and native platform payload. */
export function verifyCodexTuiProvenance(
  installation,
  { platform = process.platform, arch = process.arch } = {},
) {
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch))
    throw new Error('Unsupported native TUI containment target')
  const root = realpathSync(installation)
  const inside = (path) => {
    const canonical = realpathSync(path)
    const rel = relative(root, canonical)
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Codex provenance escaped owned installation')
    return canonical
  }
  const packagePath = inside(join(root, 'node_modules/@openai/codex/package.json'))
  const packageBytes = readFileSync(packagePath)
  const manifest = JSON.parse(packageBytes)
  if (
    manifest.name !== reviewedCodexTuiRelease.package ||
    manifest.version !== reviewedCodexTuiRelease.version
  )
    throw new Error('Codex package provenance or version mismatch')
  const launcher = inside(join(dirname(packagePath), 'bin/codex.js'))
  const platformPackage = `@openai/codex-darwin-${arch}`
  const platformPath = inside(createRequire(launcher).resolve(`${platformPackage}/package.json`))
  const platformBytes = readFileSync(platformPath)
  const payload = JSON.parse(platformBytes)
  const expectedPayload = `${reviewedCodexTuiRelease.version}-darwin-${arch}`
  if (
    payload.name !== reviewedCodexTuiRelease.package ||
    payload.version !== expectedPayload ||
    manifest.optionalDependencies?.[platformPackage] !== `npm:${payload.name}@${payload.version}`
  )
    throw new Error('Codex platform package provenance mismatch')
  const triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  const executable = inside(join(dirname(platformPath), 'vendor', triple, 'bin/codex'))
  const bytes = readFileSync(executable)
  if (
    !['cffaedfe', 'feedfacf', 'cafebabe'].includes(bytes.subarray(0, 4).toString('hex')) ||
    !(statSync(executable).mode & 0o111)
  )
    throw new Error('Codex executable is not an executable native Mach-O payload')
  const digest = (value) => createHash('sha256').update(value).digest('hex')
  return {
    ...reviewedCodexTuiRelease,
    platformPackage,
    platformVersion: payload.version,
    executable,
    packageJsonSha256: digest(packageBytes),
    platformJsonSha256: digest(platformBytes),
    launcherSha256: digest(readFileSync(launcher)),
    executableSha256: digest(bytes),
  }
}
