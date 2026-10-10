/**
 * Finding a community plugin by typing: GitHub's repository search over the
 * repositories carrying the `holi-plugin` topic, each hit read for a
 * `holi-plugin.json` and its newest release, so the settings tab can say what
 * a repository is before anything is installed.
 *
 * A topic, not code search for the manifest: code search does not index a
 * private repository promptly, and a topic scopes the search to plugins
 * without Holi keeping an index of its own.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { isRepoName, parsePluginManifest, PLUGIN_MANIFEST_FILE } from '@holi/shared'
import { newestFirst } from './fetch'

/** One repository, as the search list shows it. */
export interface Candidate {
  repo: string
  description: string
  /** Its manifest's name and description, when it is a plugin. */
  plugin: { id: string; name: string; description: string } | null
  /** The newest released version (a `v<semver>` tag), or null for none. */
  latest: string | null
  /** Why it cannot be installed, in words, or null when it can. */
  problem: string | null
}

const RESULTS = 8
const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

/** The GitHub topic a plugin's repository carries, which is what makes it
 *  findable: search looks only at repositories with it, anyone's, and the
 *  private ones the person can read. */
export const PLUGIN_TOPIC = 'holi-plugin'

/** The search for what has been typed, among repositories with the topic:
 *  `owner/name` within that owner's, `owner/` all of that owner's, anything
 *  else by name. */
export function searchQuery(typed: string): string | null {
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

/** Read `repo` as a plugin: its manifest at the default branch and its newest
 *  release. */
export async function describeRepo(
  repo: string,
  description: string,
  get: Get,
): Promise<Candidate> {
  const base = { repo, description, plugin: null, latest: null }
  const res = await get(
    `/repos/${repo}/contents/${PLUGIN_MANIFEST_FILE}`,
    'application/vnd.github.raw+json',
  )
  if (res.status === 404) return { ...base, problem: `no ${PLUGIN_MANIFEST_FILE}` }
  if (!res.ok) return { ...base, problem: `GitHub answered ${res.status}` }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { ...base, problem: `${PLUGIN_MANIFEST_FILE} is not JSON` }
  }
  const parsed = parsePluginManifest(json)
  if (!parsed.ok) return { ...base, problem: `${PLUGIN_MANIFEST_FILE} is invalid` }
  const { id, name } = parsed.value
  const plugin = { id, name, description: parsed.value.description ?? '' }
  const tags = await get(`/repos/${repo}/tags?per_page=100`)
  const versions = tags.ok
    ? ((await tags.json()) as { name: string }[]).flatMap((t) => TAG.exec(t.name)?.[1] ?? [])
    : []
  const latest = versions.sort(newestFirst)[0] ?? null
  return {
    ...base,
    plugin,
    latest,
    problem: latest === null ? `no release yet: tag v${parsed.value.version} to publish it` : null,
  }
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
  const described = await Promise.all(
    repos.slice(0, RESULTS).map((r) =>
      describeRepo(r.repo, r.description, get).catch((): Candidate => ({
        ...r,
        plugin: null,
        latest: null,
        problem: 'could not be read',
      })),
    ),
  )
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
