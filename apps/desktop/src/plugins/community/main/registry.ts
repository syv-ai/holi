/**
 * The curated list the settings tab offers, like Obsidian's community list:
 * a `plugins.json` in one repository, each entry naming a plugin's id and the
 * repository it is released from. Any other `owner/repo` installs too; the
 * list is a starting point, not a gate.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { isPluginId, isRepoName } from '@holi/shared'

export const REGISTRY_REPO = 'syv-ai/holi-plugins'
export const REGISTRY_FILE = 'plugins.json'

export interface RegistryEntry {
  id: string
  name: string
  repo: string
  description: string
}

/** The entries of a `plugins.json`; a malformed entry is left out. */
export function parseRegistry(json: unknown): RegistryEntry[] {
  if (!Array.isArray(json)) return []
  return json.flatMap((e): RegistryEntry[] => {
    if (typeof e !== 'object' || e === null) return []
    const { id, name, repo, description } = e as Record<string, unknown>
    if (!isPluginId(id) || !isRepoName(repo)) return []
    return [
      {
        id,
        repo,
        name: typeof name === 'string' ? name : id,
        description: typeof description === 'string' ? description : '',
      },
    ]
  })
}

/** The list, read through GitHub's API with the person's token, so a
 *  private list works for whoever can read it. Empty when it cannot be read. */
export async function fetchRegistry(token: string | null): Promise<RegistryEntry[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REGISTRY_REPO}/contents/${REGISTRY_FILE}`,
      {
        headers: {
          Accept: 'application/vnd.github.raw+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        },
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!res.ok) return []
    return parseRegistry(await res.json())
  } catch {
    return []
  }
}
