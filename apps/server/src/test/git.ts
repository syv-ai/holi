/** Local-repo test helpers — tests never touch github.com or ssh. */
import { mkdir } from 'node:fs/promises'
import { git } from '../git/git'
import type { GithubApi } from '../git/github-api'

/** A bare repo standing in for the GitHub-hosted remote. Returns its path (usable as a git remote). */
export async function initBareRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  await git(['init', '--bare', '--initial-branch=main', '.'], dir)
  return dir
}

/** A normal workdir repo on branch `main` with committer identity configured. */
export async function initWorkdir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  await git(['init', '--initial-branch=main', '.'], dir)
  await git(['config', 'user.name', 'Test'], dir)
  await git(['config', 'user.email', 'test@example.com'], dir)
  return dir
}

/** Stage everything and commit as the given author; returns the commit sha. */
export async function commitAll(dir: string, message: string, authorEmail = 'test@example.com'): Promise<string> {
  await git(['add', '-A'], dir)
  await git(
    ['-c', `user.email=${authorEmail}`, '-c', 'user.name=Test', 'commit', '--allow-empty-message', '-m', message],
    dir,
  )
  return git(['rev-parse', 'HEAD'], dir)
}

/** In-memory GithubApi for wiring tests. */
export function fakeGithubApi(overrides: Partial<GithubApi> = {}): GithubApi & {
  deployKeys: Array<{ id: number; key: string }>
  webhooks: Array<{ id: number; url: string; secret: string }>
} {
  const deployKeys: Array<{ id: number; key: string }> = []
  const webhooks: Array<{ id: number; url: string; secret: string }> = []
  let nextId = 1
  return {
    deployKeys,
    webhooks,
    exchangeCode: async () => ({ accessToken: 'gho_fake' }),
    getUser: async () => ({ id: 999, login: 'fake-user' }),
    getRepo: async () => ({ defaultBranch: 'main', admin: true }),
    createDeployKey: async (_t, _o, _r, _title, key) => {
      const id = nextId++
      deployKeys.push({ id, key })
      return { id }
    },
    deleteDeployKey: async (_t, _o, _r, id) => {
      const i = deployKeys.findIndex((k) => k.id === id)
      if (i >= 0) deployKeys.splice(i, 1)
    },
    createWebhook: async (_t, _o, _r, url, secret) => {
      const id = nextId++
      webhooks.push({ id, url, secret })
      return { id }
    },
    deleteWebhook: async (_t, _o, _r, id) => {
      const i = webhooks.findIndex((w) => w.id === id)
      if (i >= 0) webhooks.splice(i, 1)
    },
    ...overrides,
  }
}
