/**
 * The default Home app: the files "Create Home app" writes, when the `home`
 * setting names an app the vault does not have.
 *
 * Plain HTML and a script against the bridge, so there is nothing to build: the
 * vault assistant (or anyone) rewrites it in place. Written at the `home`
 * setting's path. Core's own Home is the recents view in the renderer; no
 * vault is seeded with this app.
 *
 * **Never overwrites**, and never writes through a link, like `holi app init`:
 * a file already there is someone's work. Never written unasked: only the
 * button on the Home tab writes it.
 */
import { lstat } from 'node:fs/promises'
import { appManifestText, vaultRelPath } from '@holi/shared'
import { exactPath } from '@holi/shared/path-safety-node'
import { writeAtomic } from '../vault/vault-files'
import homeJs from './home-app/home.js?raw'
import indexHtml from './home-app/index.html?raw'

/** Bundle-relative. The manifest last: it is what makes the app appear, and
 *  it should appear whole. */
const HOME_APP_FILES: readonly (readonly [string, string])[] = [
  ['index.html', indexHtml],
  ['home.js', homeJs],
  ['app.yaml', appManifestText('What the Home tab shows. Ask the vault assistant to change it.')],
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
