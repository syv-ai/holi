import { lstat, mkdir, realpath, rmdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pluginPinPath, vaultRelPath, type PluginPin } from '@holi/shared'
import { writeAtomic, gitignoreWith, withFileLock, CapabilityError } from '../../../main/plugin-api'
import { readManifest } from './fetch'
import { assertSafePublicationPath, readOptionalPublicationText } from './publication-files'
import {
  assertCheckoutIdentity,
  assertManifestPinned,
  canonicalJson,
  prepareAuthenticatedRelease,
  validateSkillSnapshot,
} from './skill-release'
import { seedApps, writeSkills } from './skills'
import type { Install, InstallStore } from './store'
import type { GitAccess } from './fetch'

export interface PinPublication {
  root: string
  install: Install
  pin: PluginPin
  originalPinText: string | null
  store: InstallStore
  git: GitAccess
  signal?: AbortSignal
  live?: () => boolean
  guard(): Promise<void>
  onBackups?(paths: string[]): void
}

/** Publishes one authenticated release's guide, app and ignore assets before its exact pin. */
export async function publishPin(input: PinPublication): Promise<void> {
  const { root, install, pin, store, git } = input
  if (install.source.kind !== 'release') throw new Error('only a release can be pinned')
  const source = install.source
  const id = install.id
  const pinPath = join(root, pluginPinPath(id))
  const codeDir = resolve(store.codeDir(install))
  const expectedRoot = await realpath(resolve(store.releaseDir(id, source.commit))).catch(
    () => null,
  )
  const codeReal = await realpath(codeDir).catch(() => null)
  if (
    !expectedRoot ||
    !codeReal ||
    codeReal !== resolve(expectedRoot, source.path) ||
    (!codeReal.startsWith(`${expectedRoot}${sep}`) && codeReal !== expectedRoot)
  )
    throw new CapabilityError('FORBIDDEN', `${id} release paths do not match its source`)
  const validateSource = async () => {
    const manifest = await readManifest(codeDir, source.path)
    await assertCheckoutIdentity(expectedRoot, source.commit, git.url(source.repo), input.signal)
    await assertManifestPinned(expectedRoot, source.commit, source.path, manifest, input.signal)
    if (canonicalJson(manifest) !== canonicalJson(install.manifest))
      throw new CapabilityError('FORBIDDEN', `${id} manifest does not match its source`)
  }
  const ensureLive = () => {
    if (input.live?.() === false || input.signal?.aborted)
      throw new CapabilityError('FORBIDDEN', 'community attachment is closed')
  }
  const guard = async () => {
    ensureLive()
    await assertSafePublicationPath(root, pinPath)
    const current = await store.get(id)
    if (
      !current ||
      current.source.kind !== 'release' ||
      JSON.stringify(current.source) !== JSON.stringify(source) ||
      canonicalJson(current.manifest) !== canonicalJson(install.manifest)
    )
      throw new CapabilityError('CONFLICT', `${id} changed during publication`)
    await input.guard()
    const currentPin = await readOptionalPublicationText(pinPath, 'plugin pin')
    ensureLive()
    if (currentPin !== input.originalPinText)
      throw new CapabilityError('CONFLICT', `${id} vault pin changed during publication`)
  }
  await assertSafePublicationPath(root, pinPath)
  if ((install.manifest.skills ?? []).length > 0 || (install.manifest.apps ?? []).length > 0)
    await assertSafePublicationPath(root, join(root, '.holi', 'state', 'marker'))
  await validateSource()
  const expectedSnapshots = await prepareAuthenticatedRelease({
    root: expectedRoot,
    commit: source.commit,
    sourcePath: source.path,
    originUrl: git.url(source.repo),
    manifest: install.manifest,
    skills: install.manifest.skills ?? [],
    signal: input.signal,
  })
  const validateSnapshot = async (snapshots: Parameters<typeof validateSkillSnapshot>[4]) => {
    await guard()
    await validateSkillSnapshot(
      expectedRoot,
      source.commit,
      source.path,
      install.manifest.skills ?? [],
      snapshots,
      input.signal,
    )
    await guard()
  }
  await guard()
  const ignorePath = join(root, '.gitignore')
  const originalIgnore = await readOptionalPublicationText(ignorePath, '.gitignore')
  const guides = await writeSkills(install.manifest, codeDir, root, {
    guard,
    expectedSnapshots,
    validateSnapshot,
  })
  const backups = guides.filter((path) => path.endsWith('(guide backups)'))
  if (backups.length) input.onBackups?.(backups)
  await seedApps(install.manifest, codeDir, root, {
    guard,
    signal: input.signal,
    release: { root: expectedRoot, commit: source.commit, sourcePath: source.path },
  })
  await guard()
  if ((install.manifest.ignore ?? []).length) {
    const updated = gitignoreWith(originalIgnore, install.manifest.ignore ?? [])
    if (updated !== null)
      await withFileLock(resolve(ignorePath), () =>
        writeAtomic(root, vaultRelPath('.gitignore'), updated, async () => {
          await guard()
          const current = await readOptionalPublicationText(ignorePath, '.gitignore')
          ensureLive()
          if (current !== originalIgnore)
            throw new CapabilityError('CONFLICT', 'vault .gitignore changed during publication')
        }),
      )
  }
  await guard()
  const pinDir = join(root, '.holi/plugins', id)
  let ownedIdentity: string | null = null
  try {
    await guard()
    await assertSafePublicationPath(root, pinPath)
    await mkdir(join(root, '.holi/plugins'), { recursive: true })
    const before = await lstat(pinDir).catch((error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' ? null : Promise.reject(error),
    )
    if (!before) {
      await mkdir(pinDir)
      const created = await lstat(pinDir)
      ownedIdentity = `${created.dev}:${created.ino}`
    }
    await withFileLock(resolve(pinPath), () =>
      writeAtomic(
        root,
        vaultRelPath(pluginPinPath(id)),
        `${JSON.stringify(pin, null, 2)}\n`,
        guard,
      ),
    )
  } catch (error) {
    if (ownedIdentity !== null) {
      const current = await lstat(pinDir).catch(() => null)
      if (
        current?.isDirectory() &&
        !current.isSymbolicLink() &&
        `${current.dev}:${current.ino}` === ownedIdentity
      ) {
        const contents = await import('node:fs/promises')
          .then(({ readdir }) => readdir(pinDir))
          .catch(() => null)
        if (contents?.length === 0) await rmdir(pinDir).catch(() => {})
      }
    }
    throw error
  }
}
