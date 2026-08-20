/**
 * What `holi app open` and `holi app init` actually do.
 *
 * Kept out of `agent/ops.ts` because that module is routing and error shaping:
 * these are filesystem questions about a specific vault, and they are the part
 * worth testing against real files.
 *
 * **Every refusal names the fix.** The agent is the caller, and the failure
 * mode slice 1 proved worst is silence — an app that does not appear, with
 * nothing anywhere saying why. "not registered" is only marginally better than
 * nothing; "no app.yaml — write one, or run holi app init retro" is a next
 * step.
 */
import { readFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  APPS_DIR,
  APP_MANIFEST_FILE,
  isValidAppId,
  rewriteWikiLinksMulti,
  vaultRelPath,
} from '@holi/shared'
import { absPathFor, listFiles, writeAtomic } from '../vault/vault-files'

const ENTRY_FILE = 'index.html'

export type AppOpResult = { ok: true } | { ok: false; error: string }
export type AppInitResult = { ok: true; created: string[] } | { ok: false; error: string }
export type AppRenameResult =
  | { ok: true; rewritten: { path: string; count: number }[] }
  | { ok: false; error: string }

const ID_RULE = 'an app id is lowercase letters, digits and dashes: [a-z0-9-]+'

/**
 * May this app be opened in a tab?
 *
 * The same rule the sidebar applies — manifest **and** entry document, at the
 * app's own root — re-implemented here because main cannot read a jotai atom.
 * Three call sites state it independently (this one, `migrate-manifests.ts`,
 * and the validator hook); that is deliberate, and the atoms' module doc says
 * why.
 *
 * **Opening is the only thing local authorship does.** Nothing auto-opens when
 * an app appears in the snapshot: apps sync, and a tab appearing because a
 * teammate finished writing one is a pull deciding what is on your screen.
 */
export async function openAppOp(root: string, appId: string): Promise<AppOpResult> {
  if (!isValidAppId(appId)) return { ok: false, error: `${appId}: ${ID_RULE}` }

  const dir = join(root, APPS_DIR, appId)
  if (!(await isDir(dir))) {
    return { ok: false, error: `no app called ${appId} — ${APPS_DIR}/${appId}/ does not exist` }
  }
  if (!(await isFile(join(dir, ENTRY_FILE)))) {
    return { ok: false, error: `${appId} has no ${ENTRY_FILE} — an app needs an entry document` }
  }
  if (!(await isFile(join(dir, APP_MANIFEST_FILE)))) {
    return {
      ok: false,
      error:
        `${appId} has no ${APP_MANIFEST_FILE}, so it is not registered yet. ` +
        `Write one (it can be empty), or run \`holi app init ${appId}\`.`,
    }
  }
  return { ok: true }
}

/**
 * Scaffold `.holi/apps/<id>/` — a manifest and a placeholder entry document.
 *
 * **Never overwrites.** `created` lists only what was newly written, so running
 * it on a finished app is `{ok:true, created:[]}` rather than an error: the
 * agent's intent ("make sure this app exists") is satisfied, and refusing would
 * push it towards checking first with a read it does not need.
 */
export async function initAppOp(root: string, appId: string): Promise<AppInitResult> {
  if (!isValidAppId(appId)) return { ok: false, error: `${appId}: ${ID_RULE}` }

  const created: string[] = []
  for (const [file, content] of [
    [APP_MANIFEST_FILE, manifestFor(appId)],
    [ENTRY_FILE, entryFor(appId)],
  ] as const) {
    const rel = `${APPS_DIR}/${appId}/${file}`
    if (await isFile(join(root, rel))) continue
    await writeAtomic(root, vaultRelPath(rel), content)
    created.push(rel)
  }
  return { ok: true, created }
}

/**
 * Rename an app — which is to say, rename its directory, because the id **is**
 * the directory name and also the host of its `holi-app://` URL.
 *
 * **One `rename` of the directory, not a file-by-file move.** The app is a tree
 * with nested directories and binary assets in it; walking it into a list of
 * `from`→`to` pairs would drop the empty directories and cost N syscalls to do
 * worse. It also means the move is atomic on the same filesystem: either the app
 * is at the old id or the new one, never half at each.
 *
 * The link rewrite is a second pass, and it comes **after** the directory has
 * moved: a crash between the two leaves the app renamed with stale links —
 * dangling wiki-links that show as tombstones — rather than live links pointing
 * at bytes that are gone. Same no-transaction contract as `moveNotes`.
 */
export async function renameAppOp(
  root: string,
  from: string,
  to: string,
): Promise<AppRenameResult> {
  if (!isValidAppId(from)) return { ok: false, error: `${from}: ${ID_RULE}` }
  if (!isValidAppId(to)) return { ok: false, error: `${to}: ${ID_RULE}` }
  // Renaming to the same id is what pressing Enter on an untouched field does.
  // Not an error: the caller's intent ("the app is called this") already holds.
  if (from === to) return { ok: true, rewritten: [] }

  const fromDir = join(root, APPS_DIR, from)
  const toDir = join(root, APPS_DIR, to)
  if (!(await isDir(fromDir))) {
    return { ok: false, error: `no app called ${from} — ${APPS_DIR}/${from}/ does not exist` }
  }
  if (await isDir(toDir)) {
    return {
      ok: false,
      error: `${APPS_DIR}/${to}/ already exists — pick another id, or delete that app first`,
    }
  }

  // The link map has to be built while the files are still at the old paths.
  const moved = new Map(
    (await listFiles(root, `${APPS_DIR}/${from}`)).map((p) => [
      p,
      `${APPS_DIR}/${to}/${p.slice(`${APPS_DIR}/${from}/`.length)}`,
    ]),
  )

  await rename(fromDir, toDir)

  const rewritten: { path: string; count: number }[] = []
  for (const path of await listFiles(root)) {
    if (!path.endsWith('.md')) continue
    const rel = vaultRelPath(path)
    const text = await readFile(absPathFor(root, rel), 'utf8')
    const { text: next, count } = rewriteWikiLinksMulti(text, moved)
    if (count === 0) continue
    await writeAtomic(root, rel, next)
    rewritten.push({ path, count })
  }
  return { ok: true, rewritten: rewritten.sort((a, b) => a.path.localeCompare(b.path)) }
}

function manifestFor(appId: string): string {
  const lines = [
    '# This file is what registers the app. Write it LAST when you author by',
    '# hand: the app appears the moment it exists, so a manifest written first',
    '# opens a tab onto half a page.',
    `name: ${appId}`,
    '# icon: layout-grid      # any lucide icon name',
    '# description: ...       # shown in the sidebar tooltip',
    '',
  ]
  return lines.join('\n')
}

/** A placeholder that renders something rather than a blank tab — a blank tab
 *  is indistinguishable from the app being broken, which is the exact confusion
 *  this slice exists to remove. It carries no bridge script: the bridge is
 *  injected on serve, and a hand-added one is what the validator refuses. */
function entryFor(appId: string): string {
  return `<!doctype html>
<meta charset="utf-8" />
<title>${appId}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; padding: 2rem; }
</style>
<h1>${appId}</h1>
<p>Scaffolded by <code>holi app init</code>. Replace this with the app.</p>
`
}

async function isFile(abs: string): Promise<boolean> {
  return (await stat(abs).catch(() => null))?.isFile() === true
}

async function isDir(abs: string): Promise<boolean> {
  return (await stat(abs).catch(() => null))?.isDirectory() === true
}
