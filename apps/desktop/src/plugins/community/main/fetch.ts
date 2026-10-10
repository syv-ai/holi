/**
 * Getting a community plugin's code: a release is a tag `v<version>` of its
 * repository, cloned with system git and the person's GitHub token, as a
 * vault is (so a private plugin repository works for whoever can read it).
 * A dev install is a folder read in place.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parsePluginManifest, PLUGIN_MANIFEST_FILE, type PluginManifest } from '@holi/shared'
import { CapabilityError, runGit } from '../../../main/plugin-api'

export interface GitAccess {
  /** The remote's URL: `remoteUrl(repo)` in the app, a local bare repo in tests. */
  url(repo: string): string
  token(): string | null
}

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

/** A semver's parts, for sorting newest first. A pre-release sorts below its
 *  release. */
function semverKey(version: string): [number, number, number, number] {
  const [core, pre] = version.split('-', 2)
  const [a, b, c] = core!.split('.').map(Number)
  return [a!, b!, c!, pre === undefined ? 1 : 0]
}

export function newestFirst(a: string, b: string): number {
  const ka = semverKey(a)
  const kb = semverKey(b)
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i]! - ka[i]!
  return 0
}

/** The versions a repository has released, newest first. */
export async function listVersions(repo: string, git: GitAccess): Promise<string[]> {
  const out = await runGit(process.cwd(), ['ls-remote', '--tags', '--refs', git.url(repo)], {
    token: git.token,
  })
  const versions = out
    .split('\n')
    .map((line) => line.split('\t')[1]?.replace('refs/tags/', '') ?? '')
    .flatMap((tag) => TAG.exec(tag)?.[1] ?? [])
  return [...new Set(versions)].sort(newestFirst)
}

/** Read and check the manifest at the root of `dir`. */
export async function readManifest(dir: string): Promise<PluginManifest> {
  const text = await readFile(join(dir, PLUGIN_MANIFEST_FILE), 'utf8').catch(() => null)
  if (text === null)
    throw new CapabilityError('BAD_REQUEST', `there is no ${PLUGIN_MANIFEST_FILE} in ${dir}`)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new CapabilityError('BAD_REQUEST', `${PLUGIN_MANIFEST_FILE} is not JSON`)
  }
  const parsed = parsePluginManifest(json)
  if (!parsed.ok)
    throw new CapabilityError(
      'BAD_REQUEST',
      `${PLUGIN_MANIFEST_FILE}: ${parsed.problems.join('; ')}`,
    )
  return parsed.value
}

/**
 * Clone `repo` at `v<version>` into `releaseDir(id, commit)`. The manifest
 * there must say that version, and `expectId` when given: a pin names an id,
 * and a repository that has become a different plugin is refused.
 */
export async function fetchRelease(
  args: {
    repo: string
    version: string
    expectId?: string
    /** Where staging happens; on the same volume as the release folders. */
    scratch: string
    releaseDir(id: string, commit: string): string
  },
  git: GitAccess,
): Promise<{ manifest: PluginManifest; commit: string; tag: string; dir: string }> {
  const tag = `v${args.version}`
  await mkdir(args.scratch, { recursive: true })
  const staging = await mkdtemp(join(args.scratch, 'fetch-'))
  const checkout = join(staging, 'code')
  try {
    await runGit(
      staging,
      [
        '-c',
        'advice.detachedHead=false',
        'clone',
        '--depth',
        '1',
        '--branch',
        tag,
        '--',
        git.url(args.repo),
        checkout,
      ],
      { token: git.token },
    )
    const commit = await runGit(checkout, ['rev-parse', 'HEAD'])
    const manifest = await readManifest(checkout)
    if (manifest.version !== args.version)
      throw new CapabilityError(
        'BAD_REQUEST',
        `${tag} of ${args.repo} says it is version ${manifest.version}`,
      )
    if (args.expectId !== undefined && manifest.id !== args.expectId)
      throw new CapabilityError(
        'BAD_REQUEST',
        `${args.repo} is the plugin ${manifest.id}, not ${args.expectId}`,
      )
    const dir = args.releaseDir(manifest.id, commit)
    const present = await stat(dir).catch(() => null)
    if (present === null) {
      await mkdir(dirname(dir), { recursive: true })
      await rename(checkout, dir)
    }
    return { manifest, commit, tag, dir }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
