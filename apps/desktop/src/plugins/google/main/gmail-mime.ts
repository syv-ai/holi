import { parseHeaderParameters } from './gmail-headers'

interface RawHeader {
  name?: string
  value?: string
}

export interface RawPart {
  mimeType?: string
  filename?: string
  headers?: RawHeader[]
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: RawPart[]
}

export function headerOf(part: RawPart | undefined, name: string): string | null {
  const found = part?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
  return found?.value ?? null
}

export type MimeLocation = {
  path: string
  alternatives: readonly { group: string; branch: number }[]
}

export class CalendarScanError extends Error {}

function declaresMediaType(part: RawPart, pattern: RegExp): boolean {
  const matches = (value: string | undefined) =>
    value !== undefined && pattern.test(value.split(';', 1)[0]!.trim())
  return (
    matches(part.mimeType) ||
    Boolean(
      part.headers?.some(
        (header) => header.name?.toLowerCase() === 'content-type' && matches(header.value),
      ),
    )
  )
}

export function isCalendarPart(part: RawPart): boolean {
  return (
    part.filename?.toLowerCase().endsWith('.ics') === true ||
    declaresMediaType(part, /^(text\/calendar|application\/ics)$/i)
  )
}

/** Validate before inspecting headers or descending. A forwarded message is an
 * opaque attachment in both projections, never evidence about this message. */
export function createMimeWalk(maxDepth = 16) {
  let nodes = 2048
  let headerBytes = 2 * 1024 * 1024
  const bounded = (within: boolean) => {
    if (!within) throw new CalendarScanError('Gmail MIME data exceeds the scan limits')
  }
  const string = (value: string | undefined) => {
    if (value === undefined) return
    if (typeof value !== 'string') throw new CalendarScanError('Invalid Gmail MIME metadata')
    bounded(value.length <= 32 * 1024)
    headerBytes -= Buffer.byteLength(value)
    bounded(headerBytes >= 0)
  }
  return (
    payload: RawPart | undefined,
    collect: (part: RawPart, location: MimeLocation, forwarded: boolean) => void,
  ) => {
    const visit = (part: RawPart, depth: number, location: MimeLocation) => {
      bounded(--nodes >= 0 && depth <= maxDepth)
      if (
        !part ||
        typeof part !== 'object' ||
        Array.isArray(part) ||
        (part.parts !== undefined && !Array.isArray(part.parts)) ||
        (part.headers !== undefined && !Array.isArray(part.headers))
      )
        throw new CalendarScanError('Invalid Gmail MIME part')
      string(part.mimeType)
      string(part.filename)
      bounded((part.headers?.length ?? 0) <= 128)
      for (const header of part.headers ?? []) {
        if (!header || typeof header !== 'object' || Array.isArray(header))
          throw new CalendarScanError('Invalid Gmail MIME header')
        string(header.name)
        string(header.value)
      }
      const forwarded = declaresMediaType(part, /^message\/rfc822$/i)
      collect(part, location, forwarded)
      if (forwarded || !part.parts?.length) return
      bounded(part.parts.length <= nodes && depth < maxDepth)
      const alternative = declaresMediaType(part, /^multipart\/alternative$/i)
      part.parts.forEach((child, branch) =>
        visit(child, depth + 1, {
          path: `${location.path}.${branch}`,
          alternatives: alternative
            ? [...location.alternatives, { group: location.path, branch }]
            : location.alternatives,
        }),
      )
    }
    if (payload === undefined) bounded(--nodes >= 0)
    else visit(payload, 0, { path: '0', alternatives: [] })
  }
}

// A missing MIME method leaves the iCalendar METHOD authoritative. A malformed
// or contradictory declaration does not, even when another part looks usable.
export function calendarMimeMethod(part: RawPart): string | undefined | null {
  const headers = (part.headers ?? []).filter(({ name }) => name?.toLowerCase() === 'content-type')
  if (headers.length > 1 || (headers.length && typeof headers[0]?.value !== 'string')) return null
  let method: string | undefined
  for (const value of [headers[0]?.value, part.mimeType]) {
    if (value === undefined) continue
    const unfolded = value.replace(/\r\n[\t ]+/g, ' ')
    if (/[\r\n\x00]/.test(unfolded)) return null
    const type = parseHeaderParameters(unfolded)
    if (!type || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(type.main))
      return null
    const hint = type.parameters.get('method')?.toUpperCase()
    if (hint !== undefined) {
      if (!/^[A-Z][A-Z0-9-]*$/.test(hint) || (method !== undefined && method !== hint)) return null
      method = hint
    }
  }
  return method
}
