/**
 * Core's capabilities: the vault's notes (and an app's write of one), search, recents, settings, members,
 * history and sync, and bringing this release's skills to it. They run
 * whatever features are on.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { readFile } from 'node:fs/promises'
import {
  isAppBundlePath,
  syncLabel,
  type RecentEntry,
  type SyncState,
  type VaultRelPath,
  type VaultSnapshot,
} from '@holi/shared'
import { writeOut } from '../vault/out-files'
import { readVaultSettings } from '../vault/settings'
import { withFileLock, writeAtomic } from '../vault/vault-files'
import { isSearchable, searchVault, type SearchHit } from '../vault/search'
import { CapabilityError, unavailable } from './error'
import {
  inSnapshot,
  readableOrNull,
  readablePath,
  readNote,
  requireOpen,
  shownPath,
  writableFile,
  writablePath,
} from './fences'
import { limitParam, noParams, paramsObject, pathParams, stringParam } from './params'
import { cap, type CapabilityContext } from './registry'
import { renderNote } from './render-note'

/** Recents an app may see: things it can name or open. The renderer leaves
 *  out the tabs `holi.open` cannot open (a terminal). */
const APP_RECENT_KINDS: ReadonlySet<RecentEntry['kind']> = new Set(['path', 'surface'])

/** The nav's words for the state, and the conflicting paths, which the nav's
 *  banner carries. */
function syncText(state: SyncState | null): string {
  if (state === null) return 'not open'
  const text = syncLabel(state).text
  return state.kind === 'conflict' || state.kind === 'reconciling'
    ? [text, ...state.paths].join('\n')
    : text
}

/** The namespaces core owns. */
export const VAULT_NAMESPACES = ['docs', 'vault', 'sync', 'skills'] as const

/**
 * What an update of the vault's skills did. Holi cannot merge a file the vault
 * changed too; `conflicts` then carries the first turn of a session that
 * would, and the summary to show once one is on it. Starting that session is
 * the renderer's, through the agent service, so with no agent the new
 * versions just wait beside the files.
 */
export interface SkillsUpdated {
  summary: string
  /** The vault files it replaced, added or merged, by path. */
  changed: string[]
  conflicts: { prompt: string; summary: string } | null
}

/** Where the vault's skills stand against this release. */
export interface SkillsStatus {
  /** The shipped files an update would bring, by vault path. */
  pending: string[]
  /** The Holi version that last wrote shipped files on this machine, or null
   *  when none has (a clone this machine never seeded or updated). */
  release: string | null
  /** Whether the vault asks for the update to run on open
   *  (`autoUpdateSkills` in `.holi/settings/app.yaml`). */
  autoUpdate: boolean
}

export interface VaultCapabilitiesDeps {
  /**
   * Bring this release's skills and hooks into the vault, merged with its own
   * changes. Throws the refusal.
   */
  updateSkills(remote: string): Promise<SkillsUpdated>
  /** Whether an update would bring the vault anything, and what it said
   *  last; writes nothing. */
  skillsStatus(remote: string): Promise<SkillsStatus>
  /** Show `path` to the person in a tab of `remote`'s window. Throws the
   *  refusal. */
  open(remote: string, path: VaultRelPath): void
  /** Show `path` the same way, then a PNG of its tab once it has drawn.
   *  Throws the refusal. */
  screenshot(remote: string, path: VaultRelPath): Promise<Uint8Array>
}

/** A path the agent may show, by its normalised name (`shownPath`): a file
 *  the vault's snapshot holds, or a vault app (a directory, which the snapshot
 *  lists among `dirs`). A trailing slash is dropped: a shell completes a folder
 *  with one, and an app's bundle is a folder. */
async function shownFile(ctx: CapabilityContext, path: string): Promise<VaultRelPath> {
  const rel = shownPath(path.replace(/\/+$/, ''))
  if (isAppBundlePath(rel) && (await ctx.snapshot()).dirs.includes(rel)) return rel
  return inSnapshot(ctx, rel, path)
}

export const vaultCapabilities = (deps: VaultCapabilitiesDeps) => ({
  'docs.list': cap({
    doors: ['app', 'cli'],
    cli: { args: [], summary: 'every note an app may read, one path per line' },
    params: noParams,
    // The listing, not just the read: an app that cannot open a memory but can
    // see every memory's path has still been told what the vault remembers.
    run: async (ctx): Promise<VaultSnapshot['docs']> =>
      (await ctx.snapshot()).docs.filter((d) => readableOrNull(d.path) !== null),
    text: (docs) => docs.map((d) => d.path).join('\n'),
  }),

  'docs.read': cap({
    doors: ['app', 'cli'],
    cli: { args: ['path'], summary: "a note's text, as an app reads it" },
    params: pathParams,
    run: (ctx, { path }): Promise<string> => readNote(ctx, path),
    text: (body) => body,
  }),

  'docs.render': cap({
    doors: ['app', 'cli'],
    cli: { args: ['path'], summary: 'a note as the HTML a vault app shows' },
    params: pathParams,
    run: async (ctx, { path }): Promise<string> => renderNote(await readNote(ctx, path)),
    text: (html) => html,
  }),

  /**
   * Show a note, task, PDF, vault app or any vault file in a tab, so the
   * agent can say "here it is" rather than "go to X". The CLI door only: the
   * agent may show the person its own surface, and an app has `holi.open`.
   * Never a secret file or this machine's state (`.holi/state/` holds the
   * bridge's tokens): a prompt-injected agent must not put either on screen.
   * Reversible: the tab closes.
   */
  'docs.open': cap({
    doors: ['cli'],
    cli: { args: ['path'], summary: 'show a note, task or other vault file in a tab' },
    params: pathParams,
    run: async (ctx, { path }) => {
      requireOpen(ctx)
      const rel = await shownFile(ctx, path)
      deps.open(ctx.remote, rel)
      return { path: rel }
    },
    text: ({ path }) => `opened ${path}`,
  }),

  /**
   * A PNG of a file's tab as the person sees it, in this vault's theme and
   * mode, so the agent can look at what it made: a vault app, a note's
   * diagram. Opens the tab first, as `docs.open` does (it brings the window
   * forward), and waits for it to finish drawing. Prints the PNG's path, a
   * machine-local file the agent reads back.
   */
  'docs.screenshot': cap({
    doors: ['cli'],
    cli: {
      args: ['path'],
      summary: "a PNG of a file's tab as the user sees it (opens it); prints the PNG's path",
    },
    params: pathParams,
    run: async (ctx, { path }) => {
      requireOpen(ctx)
      const rel = await shownFile(ctx, path)
      const png = await deps.screenshot(ctx.remote, rel)
      return { path: rel, png: await writeOut(ctx.root, 'screenshot', png, { ext: 'png' }) }
    },
    text: ({ png }) => png,
  }),

  /**
   * A note written by an app, as a member's editor would write it: the whole
   * text, under `writablePath`'s fences, and only over the text the app read.
   * `base` is that text, or null for a note that must not exist yet; a file
   * that changed since (a teammate's pull, the agent, the person typing) is a
   * CONFLICT, so the app reads again rather than overwrite what it never saw.
   * The text is the revision: an app already holds it, and nothing else about
   * a file says for certain that it is unchanged. A file a running plugin
   * claims is written as that plugin allows (`SnapshotClaim.checkNoteWrite`:
   * a task's body only). The app door only: the agent writes files with its
   * own tools.
   */
  'docs.write': cap({
    doors: ['app'],
    writes: true,
    params: (raw) => {
      const p = paramsObject(raw)
      const { text, base } = p
      if (typeof text !== 'string') throw new CapabilityError('BAD_REQUEST', 'text must be text')
      if (base !== null && typeof base !== 'string') {
        throw new CapabilityError(
          'BAD_REQUEST',
          'base is required: the text you read, or null for a new note',
        )
      }
      return { path: stringParam(p, 'path'), text, base }
    },
    run: async (ctx, { path, text, base }): Promise<{ path: string }> => {
      requireOpen(ctx)
      const rel = writablePath(path)
      if (!rel.endsWith('.md')) {
        throw new CapabilityError('BAD_REQUEST', `only a note (.md) can be written: ${rel}`)
      }
      const abs = await writableFile(ctx, rel)
      // One app write to a file at a time, so two over the same base cannot
      // both pass the check below.
      await withFileLock(abs, async () => {
        const current = await readFile(abs, 'utf8').catch(() => null)
        if (current !== base) {
          throw new CapabilityError(
            'CONFLICT',
            base === null
              ? `already exists: ${rel}`
              : current === null
                ? `no longer exists: ${rel}`
                : `changed since it was read: ${rel}`,
          )
        }
        const claim = (await ctx.claims()).find((c) => c.match(rel))
        try {
          claim?.checkNoteWrite?.(rel, current, text)
        } catch (err) {
          throw new CapabilityError('BAD_REQUEST', (err as Error).message)
        }
        await writeAtomic(ctx.root, rel, text)
      })
      return { path: rel }
    },
  }),

  'docs.search': cap({
    // The app door only, like `vault.settings` and `vault.history`: the agent has Grep,
    // Read and git, and a CLI twin would be a second way to do the same.
    doors: ['app'],
    params: (raw) => {
      const q = stringParam(paramsObject(raw), 'q').trim()
      if (q === '' || q.length > 200) {
        throw new CapabilityError('BAD_REQUEST', 'q must be 1 to 200 characters')
      }
      return { q }
    },
    run: async (ctx, { q }): Promise<SearchHit[]> =>
      searchVault(ctx.root, (await ctx.snapshot()).docs, q, isSearchable),
    text: (hits) => hits.map((h) => `${h.path}\t${h.snippet ?? ''}`).join('\n'),
  }),

  'vault.recents': cap({
    // Both: "the note I had open before this one" is what the agent cannot
    // find with its own tools.
    doors: ['app', 'cli'],
    cli: { args: [], summary: 'what the user opened recently, newest first' },
    params: noParams,
    run: async (ctx): Promise<RecentEntry[]> =>
      ctx.core
        .recents()
        .filter((e) => APP_RECENT_KINDS.has(e.kind))
        // A path, and a surface's id when it has one (an app's is its
        // bundle's path), go through the same fence a read does.
        .filter((e) => (e.kind === 'path' ? readableOrNull(e.key) : true))
        .filter((e) => e.id === undefined || readableOrNull(e.id) !== null),
    text: (entries) =>
      entries
        .map((e) => [e.kind, e.key, ...(e.id === undefined ? [] : [e.id])].join('\t'))
        .join('\n'),
  }),

  'vault.settings': cap({
    doors: ['app'],
    params: noParams,
    run: async (ctx) => {
      const { warnings: _warnings, ...settings } = await readVaultSettings(ctx.root)
      return settings
    },
  }),

  'vault.members': cap({
    doors: ['app', 'cli'],
    cli: { args: [], summary: 'the people who can reach this vault on GitHub' },
    params: noParams,
    // Login and avatar only: an app has no use for who may push.
    run: (ctx) =>
      unavailable(async () =>
        (await ctx.core.members()).map((m) => ({
          login: m.login,
          ...(m.avatarUrl !== undefined ? { avatarUrl: m.avatarUrl } : {}),
        })),
      ),
    text: (members) => members.map((m) => m.login).join('\n'),
  }),

  'vault.history': cap({
    doors: ['app'],
    params: (raw) => {
      const p = paramsObject(raw)
      const path = p.path === undefined || p.path === '' ? undefined : stringParam(p, 'path')
      return { path, limit: limitParam(p, 'limit', 50, 200) }
    },
    run: async (ctx, { path, limit }) => {
      const repo = ctx.core.repo()
      if (path !== undefined) {
        // A deleted file's history is still history, so the snapshot is not
        // asked here; `--literal-pathspecs` and git's own case-sensitive match
        // are what keep `.holi/Memory/x.md` from naming `.holi/memory/x.md`.
        const rel = readablePath(path)
        return (await repo.log({ path: rel, limit })).map(({ sha, subject, date, author }) => ({
          sha,
          subject,
          date,
          author,
        }))
      }
      // The vault's history, with each commit's files. A commit that touched
      // only the agent surface (a memory, the index regen) is not shown at all,
      // and the surface's paths are dropped from the rest: an app that cannot
      // read a memory must not learn from history that one was written.
      const [commits, touched] = await Promise.all([repo.log({ limit }), repo.commitFiles(limit)])
      const filesBySha = new Map(touched.map((t) => [t.sha, t.files]))
      return commits.flatMap(({ sha, subject, date, author }) => {
        // A commit the file listing did not cover (one landed between the two
        // runs) is dropped rather than shown with no files to vouch for it.
        const all = filesBySha.get(sha)
        if (all === undefined) return []
        const files = all.filter((f) => readableOrNull(f) !== null)
        if (all.length > 0 && files.length === 0) return []
        return [{ sha, subject, date, author, files }]
      })
    },
    text: (commits) => commits.map((c) => `${c.date}\t${c.author}\t${c.subject}`).join('\n'),
  }),

  'sync.status': cap({
    doors: ['app', 'cli'],
    cli: { args: [], summary: "the vault's sync state, as the nav shows it" },
    params: noParams,
    run: async (ctx): Promise<SyncState | null> => {
      const state = ctx.core.syncState()
      // An app is not told the names of conflicting agent-surface files; the
      // agent, at the CLI door, is.
      if (ctx.bundle === null || state === null) return state
      if (state.kind !== 'conflict' && state.kind !== 'reconciling') return state
      return { ...state, paths: state.paths.filter((p) => readableOrNull(p) !== null) }
    },
    text: syncText,
  }),

  /** `holi skills status`, and the nav's notice that an update exists. */
  'skills.status': cap({
    doors: ['ui', 'cli'],
    cli: {
      args: [],
      summary:
        'the skills and hooks this release would bring the vault, one path per line, and the release they came from',
    },
    params: noParams,
    run: (ctx): Promise<SkillsStatus> => deps.skillsStatus(ctx.remote),
    text: ({ pending, release }) =>
      [
        release === null ? null : `From Holi ${release}.`,
        pending.length === 0 ? 'Skills are up to date.' : pending.join('\n'),
      ]
        .filter((line) => line !== null)
        .join('\n'),
  }),

  /** `holi skills update`, and the palette's Update skills. */
  'skills.update': cap({
    doors: ['ui', 'cli'],
    cli: {
      args: [],
      summary: "bring this release's skills and hooks into the vault, merged with its own changes",
    },
    writes: true,
    params: noParams,
    run: (ctx): Promise<SkillsUpdated> => deps.updateSkills(ctx.remote),
    text: (result) => result.summary,
  }),
})
