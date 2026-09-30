/**
 * The app a new vault's Home tab shows, and the files "Create Home app" writes.
 *
 * Plain HTML and a script against the bridge, so there is nothing to build: the
 * vault assistant (or anyone) rewrites it in place. Written at the `home`
 * setting's path, which is `Home.app` unless the vault says otherwise.
 *
 * **Never overwrites**, and never writes through a link, like `holi app init`: a file already there is someone's
 * work. And never written unasked into a vault that exists: `ensureSeeded`
 * writes it only while creating one, and an existing vault gets it from the
 * button on its Home tab.
 */
import { lstat } from 'node:fs/promises'
import { vaultRelPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import { writeAtomic } from '../vault/vault-files'
import homeJs from './home-app/home.js?raw'
import indexHtml from './home-app/index.html?raw'
import manifest from './home-app/app.yaml?raw'

/** Bundle-relative. The manifest last: it is what makes the app appear, and
 *  it should appear whole. */
export const HOME_APP_FILES: readonly (readonly [string, string])[] = [
  ['index.html', indexHtml],
  ['home.js', homeJs],
  ['app.yaml', manifest],
]

/** Write the Home app's files under `bundle` that are not there yet. Returns
 *  the vault paths it created. */
export async function writeHomeApp(root: string, bundle: string): Promise<string[]> {
  const created: string[] = []
  for (const [file, content] of HOME_APP_FILES) {
    const rel = vaultRelPath(`${bundle}/${file}`)
    // Nothing through a symlink: a committed `Home.app -> ../elsewhere` must
    // not take these writes out of the vault.
    const abs = await exactPath(root, rel)
    if (abs === null || (await lstat(abs).catch(() => null)) !== null) continue
    await writeAtomic(root, rel, content)
    created.push(rel)
  }
  return created
}
