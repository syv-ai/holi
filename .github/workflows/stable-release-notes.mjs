import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function previousStableRelease(releases, currentTag) {
  return releases
    .filter(
      (release) =>
        release.tag_name !== currentTag &&
        !release.draft &&
        !release.prerelease &&
        stableTagPattern.test(release.tag_name ?? '') &&
        release.published_at &&
        Number.isFinite(Date.parse(release.published_at)),
    )
    .sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at))[0]
    ?.tag_name
}

export function getPreviousStableTag({ repository, currentTag, runGhApi = execFileSync }) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository identity: ${repository}`)
  }

  const output = runGhApi(
    'gh',
    ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`],
    { encoding: 'utf8' },
  )
  const pages = JSON.parse(output)
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error('GitHub releases response was not a paginated release list')
  }

  return previousStableRelease(pages.flat(), currentTag)
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [currentTag] = process.argv.slice(2)
  const repository = process.env.GITHUB_REPOSITORY
  if (!currentTag || !repository) {
    throw new Error('Expected a release tag argument and GITHUB_REPOSITORY')
  }
  const tag = getPreviousStableTag({ repository, currentTag })
  if (tag) process.stdout.write(`${tag}\n`)
}
