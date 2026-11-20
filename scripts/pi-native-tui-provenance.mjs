import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const packageName = '@earendil-works/pi-coding-agent'
const supportedVersion = '1.5.2'
// Reviewed against the official npm tarball's SHA-512, not a version-shaped executable.
const reviewedBundleDigest = 'c08ad70f102c06cb05809284d0ecc698c52320da4bf58e124c681b0b068747aa'
const tarballIntegrity =
  'sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA=='

export const reviewedPiRelease = Object.freeze({
  supportedVersion,
  reviewedBundleDigest,
  tarballIntegrity,
})
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

class FixtureError extends Error {
  constructor(message, outcome = 'unverified') {
    super(message)
    this.outcome = outcome
  }
}

/** Inspect package bytes without executing producer code. */
export async function verifyPiProvenance({ bin, expectedVersion }) {
  if (!bin || !expectedVersion) throw new Error('Pi binary and exact expected version are required')
  let executable
  try {
    executable = realpathSync(bin)
  } catch {
    throw new FixtureError('Pi package provenance unavailable')
  }
  let directory = dirname(executable),
    manifest,
    manifestPath
  for (let depth = 0; depth < 8; depth++) {
    manifestPath = join(directory, 'package.json')
    try {
      const candidate = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (candidate.name === packageName) {
        manifest = candidate
        break
      }
    } catch {}
    directory = dirname(directory)
  }
  if (!manifest) throw new FixtureError('Pi package provenance unavailable')
  if (manifest.version !== expectedVersion || executable !== join(directory, 'dist/bundle/cli.js'))
    throw new FixtureError('Pi package identity/version or entrypoint mismatch', 'mismatch')
  const files = []
  const collect = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (entry.name.endsWith('.js')) files.push(path)
    }
  }
  collect(join(directory, 'dist/bundle'))
  const digest = createHash('sha256')
    .update(readFileSync(manifestPath))
    .update(readFileSync(executable))
  for (const path of files.sort())
    digest.update(path.slice(directory.length + 1)).update(readFileSync(path))
  return {
    executable,
    packageDirectory: directory,
    package: packageName,
    version: manifest.version,
    packageDigest: digest.digest('hex'),
    packageSource: manifest.repository,
    sourceCommit: manifest.gitHead ?? null,
    sourceCommitAvailable: Boolean(manifest.gitHead),
  }
}

export function sourceEvidence(directory) {
  const core = 'dist/bundle/chunks/chunk-VEJDBY3O.js'
  const trust = 'dist/bundle/chunks/chunk-MMDXLZVS.js'
  return [
    [
      core,
      'function formatProjectTrustPrompt(',
      'Project trust has a native selector with explicit trust and deny choices.',
    ],
    [
      core,
      'let selected=await selectProjectTrustOption(',
      'Cancelling the native selector returns no choice; the resolver then returns false (untrusted).',
    ],
    [
      trust,
      'function getProjectTrustOptions(',
      'Trust and Do not trust are distinct native choices.',
    ],
    [
      core,
      'async showExtensionConfirm(',
      'Extension confirmations are native Yes/No selectors classified as permission UI.',
    ],
    [
      core,
      'async _beforeToolCall(',
      'Extension tool_call handlers can block a tool; exceptions also block execution.',
    ],
    [
      core,
      'async function executePreparedToolCall(',
      'Prepared core tools execute directly; extensions supply optional per-tool policy.',
    ],
    [core, '"app.clear":', 'The default Ctrl+C binding clears the native editor.'],
  ].map(([file, marker, meaning]) => {
    const bytes = readFileSync(join(directory, file)),
      text = bytes.toString(),
      index = text.indexOf(marker)
    if (index < 0)
      throw new FixtureError(`Reviewed Pi source marker missing: ${marker}`, 'mismatch')
    return {
      file,
      sha256: sha256(bytes),
      byteOffset: Buffer.byteLength(text.slice(0, index)),
      meaning,
      excerpt: text.slice(index, index + 900),
    }
  })
}
