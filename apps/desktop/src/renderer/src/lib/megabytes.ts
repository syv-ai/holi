const MB = 1024 * 1024

/** A size the way the commit size limit is named, in Settings and wherever a
 *  file is held back against it: `10 MB`, `11.7 MB`. */
export function megabytes(bytes: number): string {
  const mb = bytes / MB
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
}
