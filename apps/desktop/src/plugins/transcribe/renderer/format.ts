/** Small pure helpers the meetings surface shares. */

/** Bytes as base64, in slices so a long chunk does not overflow the call stack. */
export function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** A profile id from its name: lowercase words joined by dashes, unique among
 *  `taken`, and short enough for main, which takes at most 40 characters. */
export function profileId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 32)
      .replace(/^-+|-+$/g, '') || 'profile'
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}
