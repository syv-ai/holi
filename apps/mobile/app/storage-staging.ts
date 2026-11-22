export const stageNamePattern =
  /^stage-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}\.tmp$/i

/** Prior root-byte layout. Only recognized direct artifacts are migrated from here. */
export function legacyStagingDirectory(library: string, root: string): string {
  const key = Array.from(unescape(encodeURIComponent(root)), (char) =>
    char.charCodeAt(0).toString(16).padStart(2, '0'),
  ).join('')
  return `${library}/HoliVaultStorage/${key.match(/.{1,64}/g)?.join('/') ?? ''}`
}

/** Lossless root namespace shared by the native implementation and its host verifier. */
export function stagingDirectory(library: string, root: string): string {
  const key = Array.from(unescape(encodeURIComponent(root)), (char) =>
    char.charCodeAt(0).toString(16).padStart(2, '0'),
  ).join('')
  return `${library}/HoliVaultStorage/${key.match(/.{1,64}/g)?.join('/') ?? ''}/artifacts`
}

export const interruptionBefore = '\uFEFForiginal durable bytes\r\nCafe\u0301\r\n'
export const interruptionPending = 'replacement that must never publish'
export const interruptionAfter = 'recovered and saved\r\n'
export const interruptionArtifacts = [
  ['unowned.md', 'unowned user bytes'],
  ['.holi-storage-stage-00000000-0000-0000-0000-000000000000.tmp', 'unowned temporary bytes'],
  [
    '.holi-storage-stage-00000000-0000-0000-0000-000000000000.tmp.owner',
    '{"schemaVersion":1,"owner":"holi","root":"forged"}',
  ],
  ['.holi-storage-stage-FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF.tmp.owner', '{malformed'],
] as const
