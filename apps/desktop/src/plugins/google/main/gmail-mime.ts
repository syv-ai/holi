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

const MIME_TYPE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*\/[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)$/

// MIME permits comments between tokens. A comment is whitespace, never part
// of a token or a quoted parameter. The walker bounds header size first.
function mimeDeclaration(value: string) {
  const unfolded = value.replace(/\r\n[\t ]+/g, ' ')
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(unfolded)) return null
  let clean = ''
  let comments = 0
  let quoted = false
  let escaped = false
  for (const char of unfolded) {
    if (escaped) {
      if (!comments) clean += char
      escaped = false
    } else if (char === '\\' && (comments || quoted)) {
      if (!comments) clean += char
      escaped = true
    } else if (!quoted && char === '(') {
      if (comments++ === 0) clean += ' '
    } else if (!quoted && char === ')') {
      if (!comments) return null
      comments--
    } else if (!comments) {
      if (char === '"') quoted = !quoted
      clean += char
    }
  }
  if (comments || quoted || escaped) return null
  const type = MIME_TYPE.exec(clean.split(';', 1)[0]!.trim())
  return (
    type && {
      mediaType: `${type[1]}/${type[2]}`.toLowerCase(),
      parameters: parseHeaderParameters(clean)?.parameters ?? null,
    }
  )
}

function mediaType(value: string | undefined) {
  // A malformed declaration can still be a calendar *hint*, but cannot prove
  // its method or authorize traversal. Keep simple malformed calendar leaves
  // visible to the scan so they cannot silently disappear as evidence.
  return value === undefined
    ? undefined
    : (mimeDeclaration(value)?.mediaType ?? value.split(';', 1)[0]!.trim().toLowerCase())
}

function declaresMediaType(part: RawPart, pattern: RegExp): boolean {
  const matches = (value: string | undefined) => pattern.test(mediaType(value) ?? '')
  return (
    matches(part.mimeType) ||
    Boolean(
      part.headers?.some(
        (header) => header.name?.toLowerCase() === 'content-type' && matches(header.value),
      ),
    )
  )
}

function routingMediaType(part: RawPart): string | undefined {
  const headers = (part.headers ?? []).filter(({ name }) => name?.toLowerCase() === 'content-type')
  const declarations = [
    ...(part.mimeType === undefined ? [] : [part.mimeType]),
    ...headers.map(({ value }) => value),
  ].map((value) => ({
    parsed: value === undefined ? null : mimeDeclaration(value),
    bareType: value?.split(';', 1)[0]!.trim().toLowerCase(),
  }))
  const containerType = /^(multipart|message)\//
  const container = declarations.find(({ parsed, bareType }) =>
    containerType.test(parsed?.mediaType ?? bareType ?? ''),
  )
  // Only a verified container permits looking at children. A generic Gmail
  // wrapper may defer to the header; concrete declarations must agree.
  if (!container && !part.parts?.length) return undefined
  const routing = container?.parsed?.mediaType
  if (!routing || declarations.some(({ parsed }) => !parsed?.parameters))
    throw new CalendarScanError('Gmail returned an invalid MIME container declaration')
  if (
    headers.length > 1 ||
    declarations.some(
      ({ parsed }) =>
        parsed!.mediaType !== routing && parsed!.mediaType !== 'application/octet-stream',
    )
  )
    throw new CalendarScanError('Gmail returned conflicting MIME container declarations')
  return routing
}

export function isCalendarPart(part: RawPart): boolean {
  return (
    part.filename?.toLowerCase().endsWith('.ics') === true ||
    declaresMediaType(part, /^(text\/calendar|application\/ics)$/i)
  )
}

function isFullPart(part: RawPart, routing: string | undefined): boolean {
  if (
    typeof part.mimeType !== 'string' ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:;[^\r\n]*)?$/.test(part.mimeType)
  )
    return false
  const { body, parts } = part
  if (
    body !== undefined &&
    (!body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      (body.size !== undefined && (!Number.isSafeInteger(body.size) || body.size < 0)) ||
      (body.data !== undefined && typeof body.data !== 'string') ||
      (body.attachmentId !== undefined &&
        (typeof body.attachmentId !== 'string' || !body.attachmentId)))
  )
    return false
  // A container needs its children; a leaf needs its body or an attachment
  // descriptor. Gmail may omit inline data for an empty body.
  return (
    Boolean(parts?.length) ||
    (!routing?.startsWith('multipart/') &&
      body !== undefined &&
      (body.size === 0 || body.data !== undefined || body.attachmentId !== undefined))
  )
}

/** Validate before visiting or descending. Only unmasked full responses require
 * a complete part tree. A forwarded message stays an opaque attachment. */
export function createMimeWalk(maxDepth = 16, format: 'partial' | 'full' = 'partial') {
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
      const routing = routingMediaType(part)
      if (format === 'full' && !isFullPart(part, routing))
        throw new CalendarScanError('Gmail returned an incomplete or invalid full MIME part')
      const forwarded = routing?.startsWith('message/') === true
      collect(part, location, forwarded)
      if (forwarded || !part.parts?.length) return
      bounded(part.parts.length <= nodes && depth < maxDepth)
      const alternative = routing === 'multipart/alternative'
      part.parts.forEach((child, branch) =>
        visit(child, depth + 1, {
          path: `${location.path}.${branch}`,
          alternatives: alternative
            ? [...location.alternatives, { group: location.path, branch }]
            : location.alternatives,
        }),
      )
    }
    if (payload === undefined) {
      if (format === 'full') throw new CalendarScanError('Gmail returned no full MIME payload')
      bounded(--nodes >= 0)
    } else visit(payload, 0, { path: '0', alternatives: [] })
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
    const type = mimeDeclaration(value)
    if (!type?.parameters) return null
    const hint = type.parameters.get('method')?.toUpperCase()
    if (hint !== undefined) {
      if (!/^[A-Z][A-Z0-9-]*$/.test(hint) || (method !== undefined && method !== hint)) return null
      method = hint
    }
  }
  return method
}
