/**
 * The GitHub REST surface Holi actually uses — four reads and one write.
 *
 * Deliberately not Octokit: we make five kinds of request, and the client that
 * wraps them would be larger than they are. What this module owns instead is
 * the part a generic client would not do for us — **classifying a refusal**.
 *
 * The classification is the whole point. GitHub says no in four materially
 * different ways that all arrive as a 401 or a 403, and each one sends the user
 * somewhere different: re-authenticate, authorize the token for the org, wait
 * for the rate limit, or accept that this repo is not yours. Reporting the
 * wrong one sends someone to fix the wrong thing — the same failure mode
 * `classifyPushFailure` exists to avoid on the git side.
 */
import type { Collaborator } from '@holi/shared'
import { isRemote } from '../vault/registry'

export interface Viewer {
  /** FR-6: the identity key. A login is display only — it can be renamed. */
  accountId: number
  login: string
  name?: string
  avatarUrl?: string
}

export interface Repo {
  /** `owner/repo` — the same identity `VaultEntry` and `cloneRepo` speak. */
  remote: string
  private: boolean
  /** ISO. The picker's sort key (FR-7: "sorted by recent push"). */
  pushedAt: string
  defaultBranch: string
  /**
   * `permissions.push`. A repo you cannot push to would become a vault that
   * cannot publish, so the picker offers it visibly disabled rather than
   * letting someone discover it at their first Publish.
   */
  canPush: boolean
  owner: { login: string; kind: 'user' | 'org' }
}

export interface ApiDeps {
  /** A getter, not a string — the same reason `GitDeps.token` is one: a
   * sign-out then takes effect on the next call, not the next restart. */
  token: () => string | null
  /**
   * FR-14. Called on a **401 and nothing else**. A 403 is a repo you lack
   * access to, a rate limit, or SAML — none of them mean the token is dead.
   */
  onUnauthorized?: () => void
  fetch?: typeof globalThis.fetch
  baseUrl?: string
}

/** The five refusals that change what the user is told. Everything else is
 * `other`, because inventing a fifth meaning is how a wrong message ships. */
export type GitHubErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'saml-required'
  | 'rate-limited'
  | 'not-found'
  | 'other'

export class GitHubApiError extends Error {
  status: number
  kind: GitHubErrorKind
  /** `saml-required` only: the URL from `X-GitHub-SSO`, which is the one thing
   * that turns this error into something a user can act on. */
  ssoUrl?: string

  constructor(status: number, kind: GitHubErrorKind, message: string, ssoUrl?: string) {
    super(message)
    this.name = 'GitHubApiError'
    this.status = status
    this.kind = kind
    if (ssoUrl) this.ssoUrl = ssoUrl
  }
}

const DEFAULT_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const REQUEST_TIMEOUT_MS = 15_000

export class GitHubApi {
  #deps: ApiDeps
  #base: string
  #fetch: typeof globalThis.fetch

  constructor(deps: ApiDeps) {
    this.#deps = deps
    this.#base = deps.baseUrl ?? DEFAULT_BASE
    this.#fetch = deps.fetch ?? globalThis.fetch
  }

  async viewer(): Promise<Viewer> {
    return toViewer(await this.#request(`${this.#base}/user`))
  }

  /** Every page, newest push first. */
  async repos(): Promise<Repo[]> {
    // `affiliation` is stated rather than left to the default. The default
    // happens to be exactly this today, and it is the single line that makes
    // org-owned vaults appear in the picker — a changed default would remove
    // them silently, which is the worst way for a vault to go missing.
    const url =
      `${this.#base}/user/repos?per_page=100&sort=pushed&direction=desc` +
      `&affiliation=owner,collaborator,organization_member`

    const raw = await this.#paginate(url)
    return raw
      .map(toRepo)
      .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
  }

  /** One repo. */
  async repo(remote: string): Promise<Repo> {
    return toRepo(await this.#request(`${this.#base}/repos/${assertRemote(remote)}`))
  }

  async collaborators(remote: string): Promise<Collaborator[]> {
    const raw = await this.#paginate(
      `${this.#base}/repos/${assertRemote(remote)}/collaborators?per_page=100`,
    )
    return raw.map(toCollaborator)
  }

  async #request(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await this.#send(url, init)
    return (await res.json()) as Record<string, unknown>
  }

  /** Follow `Link`'s `rel="next"` to the end. Without this a user with more
   * than 100 repos silently loses the tail. */
  async #paginate(first: string): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = []
    let url: string | null = first

    while (url !== null) {
      const res = await this.#send(url)
      const page = (await res.json()) as unknown
      if (Array.isArray(page)) all.push(...(page as Record<string, unknown>[]))
      url = nextLink(res.headers.get('link'))
    }
    return all
  }

  async #send(url: string, init?: RequestInit): Promise<Response> {
    const token = this.#deps.token()
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      // Pinned so a future default cannot quietly reshape a response.
      'X-GitHub-Api-Version': API_VERSION,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      // Signed out still sends the request: a 401 is then the single place
      // that reports it, rather than two code paths meaning the same thing.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }

    const res = await this.#fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.ok) return res

    // The body may hold GitHub's message, which is often good. The request
    // headers must never appear here — they carry the token.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const message = typeof body.message === 'string' ? body.message : res.statusText
    const err = classify(res, message)

    if (err.kind === 'unauthorized') this.#deps.onUnauthorized?.()
    throw err
  }
}

/**
 * Order is the correctness here. Two of these are 403s, and reading a
 * rate-limited response as a permission failure tells someone they lost access
 * they still have.
 */
function classify(res: Response, message: string): GitHubApiError {
  const { status } = res

  if (status === 401) {
    return new GitHubApiError(status, 'unauthorized', `GitHub rejected the token: ${message}`)
  }

  if (status === 429 || (status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    return new GitHubApiError(status, 'rate-limited', `GitHub rate limit reached: ${message}`)
  }

  const sso = ssoUrlFrom(res.headers.get('x-github-sso'))
  if (status === 403 && sso !== null) {
    return new GitHubApiError(
      status,
      'saml-required',
      'this token is not authorized for the organization — authorize it and try again',
      sso,
    )
  }

  if (status === 403) return new GitHubApiError(status, 'forbidden', message)
  if (status === 404) return new GitHubApiError(status, 'not-found', message)
  return new GitHubApiError(status, 'other', `GitHub returned ${status}: ${message}`)
}

/** `required; url=https://github.com/orgs/x/sso?authorization_request=…` */
function ssoUrlFrom(header: string | null): string | null {
  if (header === null) return null
  const match = /url=(\S+)/.exec(header)
  return match?.[1] ?? null
}

/** `<https://…?page=2>; rel="next", <…>; rel="last"` */
function nextLink(header: string | null): string | null {
  if (header === null) return null
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part)
    if (match?.[1]) return match[1]
  }
  return null
}

function assertRemote(remote: string): string {
  // The value is interpolated into a URL path. `isRemote` is the validator the
  // registry already uses — a second one here could drift from it.
  if (!isRemote(remote)) throw new Error(`not an owner/repo remote: ${remote}`)
  return remote
}

function toViewer(raw: Record<string, unknown>): Viewer {
  return {
    accountId: Number(raw.id),
    login: String(raw.login),
    // GitHub really does send `null` here, and "null" rendered in a UI is the
    // classic tell that nobody checked.
    name: typeof raw.name === 'string' ? raw.name : undefined,
    avatarUrl: typeof raw.avatar_url === 'string' ? raw.avatar_url : undefined,
  }
}

function toRepo(raw: Record<string, unknown>): Repo {
  const owner = (raw.owner ?? {}) as Record<string, unknown>
  const permissions = (raw.permissions ?? {}) as Record<string, unknown>

  return {
    remote: String(raw.full_name),
    private: raw.private === true,
    pushedAt: String(raw.pushed_at),
    defaultBranch: String(raw.default_branch),
    canPush: permissions.push === true,
    owner: {
      login: String(owner.login),
      kind: owner.type === 'Organization' ? 'org' : 'user',
    },
  }
}

/**
 * Read the permission from the `permissions` object rather than `role_name`.
 *
 * Both are returned. The object is a fixed set of booleans; `role_name` is a
 * vocabulary GitHub can extend with custom org roles, and an unrecognised
 * string there would have no safe default — guessing high grants access we
 * cannot verify, guessing low hides collaborators who really are admins.
 */
function toCollaborator(raw: Record<string, unknown>): Collaborator {
  const p = (raw.permissions ?? {}) as Record<string, unknown>
  const permission: Collaborator['permission'] =
    p.admin === true
      ? 'admin'
      : p.maintain === true
        ? 'maintain'
        : p.push === true
          ? 'write'
          : p.triage === true
            ? 'triage'
            : 'read'

  return {
    accountId: Number(raw.id),
    login: String(raw.login),
    avatarUrl: typeof raw.avatar_url === 'string' ? raw.avatar_url : undefined,
    permission,
  }
}
