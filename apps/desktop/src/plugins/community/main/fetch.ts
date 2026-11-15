/**
 * Getting a community plugin's code: a release is a tag of its repository
 * (`releaseTag`: `v<version>` at the root, `<id>-v<version>` in a folder),
 * cloned with system git and the person's GitHub token, as a vault is (so a
 * private plugin repository works for whoever can read it). The whole
 * repository is cloned; the plugin's code is its folder in it. A dev install
 * is a folder read in place.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  compareVersions,
  parsePluginManifest,
  parseReleaseTag,
  PLUGIN_MANIFEST_FILE,
  releaseTag,
  type PluginManifest,
} from '@holi/shared'
import { CapabilityError, runGit } from '../../../main/plugin-api'

export interface GitAccess {
  /** The remote's URL: `remoteUrl(repo)` in the app, a local bare repo in tests. */
  url(repo: string): string
  token(): string | null
}

/** For sorting versions newest first. */
export const newestFirst = (a: string, b: string): number => compareVersions(b, a)

/** Every release in a repository, of each plugin in it: one read for all. */
export async function listReleases(
  repo: string,
  git: GitAccess,
): Promise<{ path: string; version: string }[]> {
  const out = await runGit(process.cwd(), ['ls-remote', '--tags', '--refs', git.url(repo)], {
    token: git.token,
  })
  return out
    .split('\n')
    .map((line) => line.split('\t')[1]?.replace('refs/tags/', '') ?? '')
    .flatMap((tag) => parseReleaseTag(tag) ?? [])
}

/** The versions of the plugin at `path` in `releases`, newest first. */
export function versionsOf(releases: { path: string; version: string }[], path: string): string[] {
  const versions = releases.filter((r) => r.path === path).map((r) => r.version)
  return [...new Set(versions)].sort(newestFirst)
}

/** The versions the plugin at `path` in a repository has released, newest
 *  first. */
export async function listVersions(repo: string, path: string, git: GitAccess): Promise<string[]> {
  return versionsOf(await listReleases(repo, git), path)
}

/** Read an untrusted manifest or pin without following links or blocking on special files. */
export async function readBoundedRegularText(
  path: string,
  label: string,
  maxBytes = 256 * 1024,
): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes)
      throw new CapabilityError('BAD_REQUEST', `${label} is not a bounded regular file`)
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw new CapabilityError('BAD_REQUEST', `${label} changed while reading`)
      offset += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== info.size || after.dev !== info.dev || after.ino !== info.ino)
      throw new CapabilityError('BAD_REQUEST', `${label} changed while reading`)
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes))
      throw new CapabilityError('BAD_REQUEST', `${label} is not valid UTF-8`)
    return text
  } finally {
    await handle.close()
  }
}

/** Read and check the manifest in the plugin folder `dir`, which is the
 *  repository's folder `path` (`''` for its root, or for a dev folder). */
export async function readManifest(dir: string, path = ''): Promise<PluginManifest> {
  let text: string
  try {
    text = await readBoundedRegularText(join(dir, PLUGIN_MANIFEST_FILE), PLUGIN_MANIFEST_FILE)
  } catch (error) {
    if (error instanceof CapabilityError) throw error
    throw new CapabilityError('BAD_REQUEST', `there is no ${PLUGIN_MANIFEST_FILE} in ${dir}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new CapabilityError('BAD_REQUEST', `${PLUGIN_MANIFEST_FILE} is not JSON`)
  }
  const parsed = parsePluginManifest(json, path)
  if (!parsed.ok)
    throw new CapabilityError(
      'BAD_REQUEST',
      `${PLUGIN_MANIFEST_FILE}: ${parsed.problems.join('; ')}`,
    )
  return parsed.value
}

/**
 * Clone `repo` at the release of its plugin at `path` into
 * `releaseDir(id, commit)`. The manifest in that folder must say that version,
 * and `expectId` when given: a pin names an id, and a repository that has
 * become a different plugin is refused.
 */
export async function fetchRelease(
  args: {
    repo: string
    path: string
    version: string
    expectId?: string
    /** Where staging happens; on the same volume as the release folders. */
    scratch: string
    releaseDir(id: string, commit: string): string
  },
  git: GitAccess,
): Promise<{ manifest: PluginManifest; commit: string; tag: string; dir: string }> {
  const tag = releaseTag(args.path, args.version)
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
    const manifest = await readManifest(join(checkout, args.path), args.path)
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
