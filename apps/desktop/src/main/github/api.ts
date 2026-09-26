/**
 * The GitHub REST surface Holi actually uses: a handful of reads and two writes.
 *
 * Deliberately not Octokit: the client would be larger than the requests. What
 * this module owns instead is the part a generic client would not do for us:
 * **classifying a refusal**. GitHub says no in four materially different ways
 * that all arrive as a 401 or a 403, and each one sends the user somewhere
 * different: re-authenticate, authorize the token for the org, wait for the
 * rate limit, or accept that this repo is not yours.
 */
import type { Collaborator } from '@holi/shared'
import { isRemote } from '../vault/registry'

/**
 * The GitHub repo topic that marks a repo as a Holi vault.
 *
 * A vault IS a repo (D60), but not every repo you can push to is a vault. The
 * topic rides back in the repos listing for free, so the "join a vault" picker
 * can show only real vaults without a per-repo probe, and `vaults.add` can
 * refuse to seed a code repo. The on-disk twin of this flag is `.holi/vault`.
 */
export const HOLI_VAULT_TOPIC = 'holi-vault'

export interface Viewer {
  /** The identity key. A login is display only: it can be renamed. */
  accountId: number
  login: string
  name?: string
  avatarUrl?: string
}

export interface Repo {
  /** `owner/repo`: the same identity `VaultEntry` and `cloneRepo` speak. */
  remote: string
  private: boolean
  /**
   * Surfaced because a vault silently becoming public is the highest-severity
   * thing that can happen to it. `internal` is a third state, not a synonym
   * for either.
   */
  visibility: 'public' | 'private' | 'internal'
  /** ISO. The picker's sort key. */
  pushedAt: string
  defaultBranch: string
  /**
   * `permissions.push`. A repo you cannot push to would become a vault that
   * cannot publish, so the picker offers it visibly disabled rather than
   * letting someone discover it at their first Publish.
   */
  canPush: boolean
  owner: { login: string; kind: 'user' | 'org' }
  /** Carries the `holi-vault` topic. Drives the "join a vault" filter. */
  isVault: boolean
}

/** An organization the viewer belongs to: an owner "New vault" can offer. */
export interface Org {
  login: string
  avatarUrl?: string
}

export interface ApiDeps {
  /** A getter, not a string, so a sign-out takes effect on the next call. */
  token: () => string | null
  /**
   * Called on a **401 and nothing else**. A 403 is a repo you lack access to,
   * a rate limit, or SAML: none of them mean the token is dead.
   *
   * Awaited before the error is thrown, so a caller handling the rejection
   * always sees a session that already reflects the sign-out.
   */
  onUnauthorized?: () => void | Promise<void>
  fetch?: typeof globalThis.fetch
  baseUrl?: string
}

/** The refusals that change what the user is told. Everything else is
 * `other`, because inventing a meaning is how a wrong message ships. */
export type GitHubErrorKind =
  'unauthorized' | 'forbidden' | 'saml-required' | 'rate-limited' | 'not-found' | 'other'

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
    // `affiliation` is stated rather than left to the default: it is what makes
    // org-owned vaults appear in the picker, and a changed default would remove
    // them silently.
    const url =
      `${this.#base}/user/repos?per_page=100&sort=pushed&direction=desc` +
      `&affiliation=owner,collaborator,organization_member`

    const raw = await this.#paginate(url)
    return raw.map(toRepo).sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
  }

  async repo(remote: string): Promise<Repo> {
    return toRepo(await this.#request(`${this.#base}/repos/${assertRemote(remote)}`))
  }

  async collaborators(remote: string): Promise<Collaborator[]> {
    const raw = await this.#paginate(
      `${this.#base}/repos/${assertRemote(remote)}/collaborators?per_page=100`,
    )
    return raw.map(toCollaborator)
  }

  /**
   * The viewer's organizations: the only thing the `read:org` scope is for,
   * so "New vault" can offer an org as the owner. *Listing* org repos does not
   * need it; `affiliation` covers that.
   */
  async orgs(): Promise<Org[]> {
    const raw = await this.#paginate(`${this.#base}/user/orgs?per_page=100`)
    return raw.map((o) => ({
      login: String(o.login),
      avatarUrl: typeof o.avatar_url === 'string' ? o.avatar_url : undefined,
    }))
  }

  /**
   * **Always private**, and there is no parameter to say otherwise: a vault
   * created public is the highest-severity failure, so the signature makes it
   * unsayable rather than a default someone can pass around. Seeding is not
   * this module's job.
   */
  async createRepo(args: { name: string; owner?: string }): Promise<Repo> {
    const url = args.owner
      ? `${this.#base}/orgs/${encodeURIComponent(args.owner)}/repos`
      : `${this.#base}/user/repos`

    try {
      return toRepo(
        await this.#request(url, {
          method: 'POST',
          body: JSON.stringify({ name: args.name, private: true, auto_init: false }),
        }),
      )
    } catch (err) {
      // A collision is something the user can fix, but only if they are told
      // which name collided, and GitHub's 422 does not say.
      if (err instanceof GitHubApiError && err.status === 422) {
        throw new GitHubApiError(
          422,
          err.kind,
          `GitHub refused to create "${args.name}": ${err.message}`,
        )
      }
      throw err
    }
  }

  /**
   * Stamp the `holi-vault` topic onto a freshly-created repo, so it reads as a
   * vault in the listing and passes the `vaults.add` guard.
   *
   * `PUT /topics` *replaces* the topic set: safe because this only runs on a
   * repo Holi just created, which has none. Not folded into `createRepo`: it can
   * fail on its own, and a repo without the topic is recoverable, not broken.
   */
  async markVault(remote: string): Promise<void> {
    await this.#request(`${this.#base}/repos/${assertRemote(remote)}/topics`, {
      method: 'PUT',
      body: JSON.stringify({ names: [HOLI_VAULT_TOPIC] }),
    })
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

    // The body may hold GitHub's message. The request headers must never
    // appear here: they carry the token.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const message = typeof body.message === 'string' ? body.message : res.statusText
    const err = classify(res, message)

    if (err.kind === 'unauthorized') await this.#deps.onUnauthorized?.()
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
  // The value is interpolated into a URL path. Reuse the registry's validator
  // so the two cannot drift.
  if (!isRemote(remote)) throw new Error(`not an owner/repo remote: ${remote}`)
  return remote
}

function toViewer(raw: Record<string, unknown>): Viewer {
  return {
    accountId: Number(raw.id),
    login: String(raw.login),
    // GitHub really does send `null` here.
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
    // Fall back to the boolean rather than to a string: an unknown value here
    // must not read as "public" on a repo GitHub called private.
    visibility:
      raw.visibility === 'public' || raw.visibility === 'internal'
        ? raw.visibility
        : raw.private === true
          ? 'private'
          : 'public',
    pushedAt: String(raw.pushed_at),
    defaultBranch: String(raw.default_branch),
    canPush: permissions.push === true,
    owner: {
      login: String(owner.login),
      kind: owner.type === 'Organization' ? 'org' : 'user',
    },
    // `topics` rides in the repo payload by default under the pinned Accept
    // header, so this costs nothing on top of the listing GitHub already sends.
    isVault: Array.isArray(raw.topics) && raw.topics.includes(HOLI_VAULT_TOPIC),
  }
}

/**
 * Read the permission from the `permissions` object rather than `role_name`.
 *
 * The object is a fixed set of booleans; `role_name` is a vocabulary GitHub can
 * extend with custom org roles, and an unrecognised string there would have no
 * safe default.
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
