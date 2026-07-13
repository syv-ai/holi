/** github.com only in v1 (design spec §Scope). */
export interface GithubRepo {
  owner: string
  repo: string
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/

export function parseGithubRepoUrl(raw: string): GithubRepo {
  let ownerRepo: string | null = null
  const ssh = /^git@github\.com:(.+)$/.exec(raw.trim())
  if (ssh) {
    ownerRepo = ssh[1]!
  } else {
    let url: URL
    try {
      url = new URL(raw.trim())
    } catch {
      throw new Error('not a valid GitHub repository URL (github.com only)')
    }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
      throw new Error('only https://github.com/… repositories are supported')
    }
    ownerRepo = url.pathname.replace(/^\//, '')
  }
  const parts = ownerRepo.replace(/\/+$/, '').replace(/\.git$/, '').split('/')
  if (parts.length !== 2 || !parts.every((p) => p.length > 0 && SEGMENT.test(p))) {
    throw new Error('expected a github.com/<owner>/<repo> URL')
  }
  return { owner: parts[0]!, repo: parts[1]! }
}

export function sshRemote({ owner, repo }: GithubRepo): string {
  return `git@github.com:${owner}/${repo}.git`
}
