import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const mobileRelevant = [
  /^apps\/mobile\//,
  /^packages\/shared\//,
  /^pnpm-lock\.yaml$/,
  /^package\.json$/,
  /^tsconfig\.base\.json$/,
  /^patches\//,
  /^pnpm-workspace\.yaml$/,
  /^\.npmrc$/,
  /^\.github\/workflows\/mobile-ios\.yml$/,
  /^\.github\/workflows\/mobile-ios-changes\.(mjs|test\.mjs)$/,
  /^\.node-version$/,
  /^\.nvmrc$/,
]

export function needsMobileIos(paths) {
  return paths.some((path) => mobileRelevant.some((pattern) => pattern.test(path)))
}

async function main() {
  const { GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_OUTPUT } = process.env
  if (!GITHUB_EVENT_NAME || !GITHUB_EVENT_PATH || !GITHUB_OUTPUT) {
    throw new Error('GitHub event environment is required for change detection')
  }
  if (GITHUB_EVENT_NAME === 'push') {
    await appendFile(GITHUB_OUTPUT, 'run=true\n')
  } else if (GITHUB_EVENT_NAME === 'pull_request') {
    const event = JSON.parse(await readFile(GITHUB_EVENT_PATH, 'utf8'))
    if (!event.pull_request?.base?.sha || !event.pull_request?.head?.sha) {
      throw new Error('Pull request commit SHAs are missing')
    }
    const diff = execFileSync(
      'git',
      [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        `${event.pull_request.base.sha}...${event.pull_request.head.sha}`,
      ],
      { encoding: 'buffer' },
    )
    const paths = diff.toString('utf8').split('\0').filter(Boolean)
    await appendFile(GITHUB_OUTPUT, `run=${needsMobileIos(paths)}\n`)
  } else {
    throw new Error(`Unsupported event: ${GITHUB_EVENT_NAME}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
