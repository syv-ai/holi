/**
 * Core's capabilities: the vault's notes, search, recents, settings, members,
 * history and sync. They run whatever features are on.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { syncLabel, type RecentEntry, type SyncState, type VaultSnapshot } from '@holi/shared'
import { readVaultSettings } from '../vault/settings'
import { isSearchable, searchVault, type SearchHit } from '../vault/search'
import { CapabilityError, unavailable } from './error'
import { readableOrNull, readablePath, readNote } from './fences'
import { limitParam, noParams, paramsObject, pathParams, stringParam } from './params'
import { cap } from './registry'
import { renderNote } from './render-note'

/** Recents an app may see: things it can name or open, never the agent surface. */
const APP_RECENT_KINDS: ReadonlySet<RecentEntry['kind']> = new Set([
  'path',
  'app',
  'surface',
  'session',
])

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

export const VAULT_CAPABILITIES = {
  'docs.list': cap({
    doors: ['app', 'cli'],
    params: noParams,
    // The listing, not just the read: an app that cannot open a memory but can
    // see every memory's path has still been told what the vault remembers.
    run: async (ctx): Promise<VaultSnapshot['docs']> =>
      (await ctx.snapshot()).docs.filter((d) => readableOrNull(d.path) !== null),
    text: (docs) => docs.map((d) => d.path).join('\n'),
  }),

  'docs.read': cap({
    doors: ['app', 'cli'],
    params: pathParams,
    run: (ctx, { path }): Promise<string> => readNote(ctx, path),
    text: (body) => body,
  }),

  'docs.render': cap({
    doors: ['app', 'cli'],
    params: pathParams,
    run: async (ctx, { path }): Promise<string> => renderNote(await readNote(ctx, path)),
    text: (html) => html,
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
    params: noParams,
    run: async (ctx): Promise<RecentEntry[]> =>
      ctx.services
        .recents()
        .filter((e) => APP_RECENT_KINDS.has(e.kind))
        .filter((e) => (e.kind === 'path' || e.kind === 'app' ? readableOrNull(e.key) : true)),
    text: (entries) => entries.map((e) => `${e.kind}\t${e.key}`).join('\n'),
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
    params: noParams,
    // Login and avatar only: an app has no use for who may push.
    run: (ctx) =>
      unavailable(async () =>
        (await ctx.services.members()).map((m) => ({
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
      const repo = ctx.services.repo()
      if (path !== undefined) {
        // A deleted file's history is still history, so the snapshot is not
        // asked here; `--literal-pathspecs` and git's own case-sensitive match
        // are what keep `Memory/x.md` from naming `memory/x.md`.
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
    params: noParams,
    run: async (ctx): Promise<SyncState | null> => {
      const state = ctx.services.syncState()
      // An app is not told the names of conflicting agent-surface files; the
      // agent, at the CLI door, is.
      if (ctx.bundle === null || state === null) return state
      if (state.kind !== 'conflict' && state.kind !== 'reconciling') return state
      return { ...state, paths: state.paths.filter((p) => readableOrNull(p) !== null) }
    },
    text: syncText,
  }),
}
