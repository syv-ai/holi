export const DRIVE_SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'

export function isDriveFileId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]+$/.test(value)
}
