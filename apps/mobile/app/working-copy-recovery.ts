import { legacyStagingDirectory, stagingDirectory, stageNamePattern } from './storage-staging'

/** Recovery namespace entries shared with the durable storage writers. */
export function recoveryArtifactNames(current: string[], legacy: string[]): string[] {
  return [
    ...current.filter(
      (name) => stageNamePattern.test(name) || /^move-[0-9a-f-]+\.json$/i.test(name),
    ),
    ...legacy.filter(
      (name) => stageNamePattern.test(name) || /^move-[0-9a-f-]+\.json$/i.test(name),
    ),
  ]
}

export function recoveryDirectories(library: string, canonicalRoot: string): [string, string] {
  return [stagingDirectory(library, canonicalRoot), legacyStagingDirectory(library, canonicalRoot)]
}
