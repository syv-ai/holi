/**
 * What `holi app open` and `holi app init` actually do.
 *
 * Kept out of `agent/ops.ts` because that module is routing and error shaping:
 * these are filesystem questions about a specific vault, and they are the part
 * worth testing against real files.
 *
 * **Every refusal names the fix.** The agent is the caller, and the worst
 * failure is an app that does not appear with nothing saying why. "no app.yaml,
 * write one, or run holi app init Retro.app" is a next step.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  APP_MANIFEST_FILE,
  appManifestText,
  appName,
  isAppBundlePath,
  vaultRelPath,
} from '@holi/shared'
import { writeAtomic } from '../vault/vault-files'

const ENTRY_FILE = 'index.html'

export type AppOpResult = { ok: true } | { ok: false; error: string }
export type AppInitResult = { ok: true; created: string[] } | { ok: false; error: string }

const BUNDLE_RULE =
  'an app is a folder whose name ends in .app, given by its path in the vault, e.g. Finance/Budget.app'

/** `Finance/Budget.app/` and `./Finance/Budget.app` are the same answer. */
const tidy = (path: string): string => path.replace(/^\.\//, '').replace(/\/+$/, '')

/**
 * May this app be opened in a tab?
 *
 * The same rule the sidebar applies — manifest **and** entry document, at the
 * bundle's own root — re-implemented here because main cannot read a jotai
 * atom. The validator hook states it too; the atoms' module doc says why that is
 * deliberate.
 *
 * **Opening is the only thing local authorship does.** Nothing auto-opens when
 * an app appears in the snapshot: apps sync, and a tab appearing because a
 * teammate finished writing one is a pull deciding what is on your screen.
 *
 * Answers with the tidied bundle path, which is what the tab is keyed by.
 */
export async function openAppOp(
  root: string,
  path: string,
): Promise<{ ok: true; bundle: string } | { ok: false; error: string }> {
  const bundle = tidy(path)
  if (!isAppBundlePath(bundle)) return { ok: false, error: `${path}: ${BUNDLE_RULE}` }

  const dir = join(root, bundle)
  if (!(await isDir(dir))) return { ok: false, error: `no app at ${bundle}/` }
  if (!(await isFile(join(dir, ENTRY_FILE)))) {
    return { ok: false, error: `${bundle} has no ${ENTRY_FILE}; an app needs an entry document` }
  }
  if (!(await isFile(join(dir, APP_MANIFEST_FILE)))) {
    return {
      ok: false,
      error:
        `${bundle} has no ${APP_MANIFEST_FILE}, so it is not finished yet. ` +
        `Write one (it can be empty), or run \`holi app init ${bundle}\`.`,
    }
  }
  return { ok: true, bundle }
}

/**
 * Scaffold a bundle: a manifest and a placeholder entry document.
 *
 * **Never overwrites.** `created` lists only what was newly written, so running
 * it on a finished app is `{ok:true, created:[]}` rather than an error: the
 * agent's intent ("make sure this app exists") is satisfied.
 */
export async function initAppOp(root: string, path: string): Promise<AppInitResult> {
  const bundle = tidy(path)
  if (!isAppBundlePath(bundle)) return { ok: false, error: `${path}: ${BUNDLE_RULE}` }

  const created: string[] = []
  for (const [file, content] of [
    [APP_MANIFEST_FILE, appManifestText()],
    [ENTRY_FILE, entryFor(appName(bundle))],
  ] as const) {
    const rel = `${bundle}/${file}`
    if (await isFile(join(root, rel))) continue
    await writeAtomic(root, vaultRelPath(rel), content)
    created.push(rel)
  }
  return { ok: true, created }
}

/** A placeholder that renders something rather than a blank tab, which is
 *  indistinguishable from a broken app. No heading with the app's name: the tab
 *  and the tree already say it. It carries no bridge script: the bridge is
 *  injected on serve, and a hand-added one is what the validator refuses. */
function entryFor(rawName: string): string {
  const name = rawName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<!doctype html>
<meta charset="utf-8" />
<title>${name}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 1rem; }
</style>
<p>Scaffolded by <code>holi app init</code>. Replace this with the app.</p>
`
}

async function isFile(abs: string): Promise<boolean> {
  return (await stat(abs).catch(() => null))?.isFile() === true
}

async function isDir(abs: string): Promise<boolean> {
  return (await stat(abs).catch(() => null))?.isDirectory() === true
}
