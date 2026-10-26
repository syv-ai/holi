/**
 * Finding a community plugin by typing: GitHub's repository search over the
 * repositories carrying the `holi-plugin` topic, each hit read for the
 * `holi-plugin.json` at its root or in its top-level folders, and each plugin
 * for its newest release, so the settings tab can say what a repository holds
 * before anything is installed.
 *
 * A topic, not code search for the manifest: code search does not index a
 * private repository promptly, and a topic scopes the search to plugins
 * without Holi keeping an index of its own.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import {
  isPluginPath,
  isRepoName,
  parsePluginManifest,
  parseReleaseTag,
  PLUGIN_MANIFEST_FILE,
  pluginManifestPath,
  releaseTag,
} from '@holi/shared'
import { versionsOf } from './fetch'

/** One plugin in a repository, or a repository that holds none, as the search
 *  list shows it. */
export interface Candidate {
  repo: string
  /** Where in the repository: `''` for its root. */
  path: string
  description: string
  /** Its manifest's name and description, when it is a plugin. */
  plugin: { id: string; name: string; description: string } | null
  /** The newest released version (its `releaseTag`), or null for none. */
  latest: string | null
  /** Why it cannot be installed, in words, or null when it can. */
  problem: string | null
}

const RESULTS = 8

/** The GitHub topic a plugin's repository carries, which is what makes it
 *  findable: search looks only at repositories with it, anyone's, and the
 *  private ones the person can read. */
const PLUGIN_TOPIC = 'holi-plugin'

/** The search for what has been typed, among repositories with the topic:
 *  `owner/name` within that owner's, `owner/` all of that owner's, anything
 *  else by name. */
function searchQuery(typed: string): string | null {
  const text = typed.trim()
  if (text === '') return null
  const topic = `topic:${PLUGIN_TOPIC}`
  const slash = text.indexOf('/')
  if (slash < 0) return `${text} in:name ${topic}`
  const owner = text.slice(0, slash)
  const name = text.slice(slash + 1)
  if (!/^[A-Za-z0-9-]+$/.test(owner)) return null
  return name === '' ? `user:${owner} ${topic}` : `${name} in:name user:${owner} ${topic}`
}

type Get = (path: string, accept?: string) => Promise<Response>

function githubGet(token: string | null): Get {
  return (path, accept = 'application/vnd.github+json') =>
    fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      signal: AbortSignal.timeout(10_000),
    })
}

/** Folders a repository is searched for plugins in, at most: each is one
 *  more request, and a plugins repository is a handful. */
const MAX_FOLDERS = 20

type Read =
  | { kind: 'absent' }
  | { kind: 'problem'; problem: string }
  | { kind: 'plugin'; plugin: Plugin; version: string }
type Plugin = NonNullable<Candidate['plugin']>

/** The manifest of the plugin at `path` in `repo`, at the default branch. */
async function readAt(repo: string, path: string, get: Get): Promise<Read> {
  const res = await get(
    `/repos/${repo}/contents/${pluginManifestPath(path)}`,
    'application/vnd.github.raw+json',
  )
  if (res.status === 404) return { kind: 'absent' }
  if (!res.ok) return { kind: 'problem', problem: `GitHub answered ${res.status}` }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { kind: 'problem', problem: `${pluginManifestPath(path)} is not JSON` }
  }
  const parsed = parsePluginManifest(json, path)
  if (!parsed.ok) return { kind: 'problem', problem: `${pluginManifestPath(path)} is invalid` }
  const { id, name, description, version } = parsed.value
  return { kind: 'plugin', plugin: { id, name, description: description ?? '' }, version }
}

/** The top-level folders of `repo` that could be a plugin's (named like an
 *  id), at the default branch. */
async function foldersOf(repo: string, get: Get): Promise<string[]> {
  const res = await get(`/repos/${repo}/contents`)
  if (!res.ok) return []
  const entries = (await res.json()) as { name: string; type: string }[]
  return entries
    .filter((e) => e.type === 'dir' && isPluginPath(e.name) && e.name !== '')
    .map((e) => e.name)
    .slice(0, MAX_FOLDERS)
}

/**
 * Read `repo` for plugins: the one at its root, or else one in each top-level
 * folder named after its id, each with its own newest release. One candidate
 * per plugin; a repository with none is one candidate saying so.
 * @public exported for its test
 */
export async function describeRepo(
  repo: string,
  description: string,
  get: Get,
): Promise<Candidate[]> {
  const none = { repo, path: '', description, plugin: null, latest: null }
  const root = await readAt(repo, '', get)
  const reads: { path: string; read: Read }[] = []
  if (root.kind !== 'absent') reads.push({ path: '', read: root })
  else
    for (const folder of await foldersOf(repo, get)) {
      const read = await readAt(repo, folder, get)
      if (read.kind !== 'absent') reads.push({ path: folder, read })
    }
  if (reads.length === 0) return [{ ...none, problem: `no ${PLUGIN_MANIFEST_FILE}` }]
  const tags = await get(`/repos/${repo}/tags?per_page=100`)
  const releases = tags.ok
    ? ((await tags.json()) as { name: string }[]).flatMap((t) => parseReleaseTag(t.name) ?? [])
    : []
  return reads.map(({ path, read }): Candidate => {
    if (read.kind !== 'plugin')
      return { ...none, path, problem: read.kind === 'problem' ? read.problem : null }
    const latest = versionsOf(releases, path)[0] ?? null
    return {
      ...none,
      path,
      plugin: read.plugin,
      latest,
      problem:
        latest === null
          ? `no release yet: tag ${releaseTag(path, read.version)} to publish it`
          : null,
    }
  })
}

type Hit = { full_name: string; description: string | null }

async function searchRepos(q: string, get: Get): Promise<Hit[]> {
  const res = await get(`/search/repositories?per_page=${RESULTS}&q=${encodeURIComponent(q)}`)
  return res.ok ? ((await res.json()) as { items: Hit[] }).items : []
}

/** What the settings tab lists for `typed`: installable plugins first, then
 *  what matched but cannot be installed, with why, so a missing release or a
 *  broken manifest is visible as you type. */
export async function searchPlugins(typed: string, token: string | null): Promise<Candidate[]> {
  const get = githubGet(token)
  const exact = typed.trim()
  const q = searchQuery(typed)
  if (q === null) return []
  const hits = await searchRepos(q, get)
  const repos = hits.map((h) => ({ repo: h.full_name, description: h.description ?? '' }))
  // An exact owner/repo is read even when search finds nothing for it: a
  // plugin whose repository lacks the topic still installs by its name.
  if (isRepoName(exact) && hits.length === 0) repos.unshift({ repo: exact, description: '' })
  const described = (
    await Promise.all(
      repos
        .slice(0, RESULTS)
        .map((r) =>
          describeRepo(r.repo, r.description, get).catch((): Candidate[] => [
            { ...r, path: '', plugin: null, latest: null, problem: 'could not be read' },
          ]),
        ),
    )
  ).flat()
  const rank = (c: Candidate) => (c.plugin === null ? 2 : c.problem === null ? 0 : 1)
  // A typed repository search did not find may not exist at all, which a
  // missing manifest cannot tell apart.
  const found = new Set(hits.map((h) => h.full_name.toLowerCase()))
  return described
    .map((c) =>
      c.plugin === null &&
      c.problem === `no ${PLUGIN_MANIFEST_FILE}` &&
      !found.has(c.repo.toLowerCase())
        ? { ...c, problem: `not found, or no ${PLUGIN_MANIFEST_FILE}` }
        : c,
    )
    .sort((a, b) => rank(a) - rank(b))
}
