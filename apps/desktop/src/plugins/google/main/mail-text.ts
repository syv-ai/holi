/** Conservative text cleanup for the agent-facing Gmail CLI, not the reader. */
import { decodeHTML } from 'entities'

const INVISIBLE =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g

const QUOTE_START =
  /^\s*(?:On .{1,240} (?:wrote|schrieb|a écrit|escribió|ha scritto)\s*:|(?:Le|Am|El) .{1,240} (?:wrote|schrieb|a écrit|escribió)\s*:|Den .{1,240} skrev .{1,120}:|Am .{1,240} schrieb .{1,120}:)\s*$/i
const FORWARD_START =
  /^\s*(?:-{2,}\s*(?:Forwarded message|Original Message)\s*-*|Begin forwarded message:|転送メッセージ)\s*$/i
const FORWARD_HEADER = /^\s*(from|sent|date|to|subject)\s*:\s*\S/i
const MOBILE_SIGNATURE =
  /^\s*(?:Sent from my (?:iPhone|iPad|Android|mobile device)\.?|Get Outlook for (?:iOS|Android))\s*$/i
const SIGNATURE_DELIMITER = /^-- [ \t]*$/
const POSTSCRIPT = /^\s*(?:P\.?S\.?|P\.?P\.?S\.?|NB)\s*[:.! -]/i
const CALENDAR_LABEL =
  /^\s*(?:Join with Google Meet|Join Google Meet|Join Zoom Meeting|Join Microsoft Teams Meeting|Join meeting|Meeting link|Video call link|Google Meet joining info)\s*:?\s*$/i
const PROVIDER_LINK =
  /^\s*https?:\/\/(?:meet\.google\.com|zoom\.us|[\w.-]+\.zoom\.us|teams\.microsoft\.com)\/[^\s<>]+\s*$/i
const CALENDAR_DETAIL = /^\s*(?:Dial in:\s*\+?[\d ()-]+(?:\s+PIN:\s*[\d #]+)?|PIN:\s*[\d #]+)\s*$/i

function isForwardBlock(lines: string[], marker: number): boolean {
  const following = lines.slice(marker + 1, marker + 8)
  const fields = following.flatMap((line) => {
    const field = line.match(FORWARD_HEADER)?.[1]
    return field === undefined ? [] : [field.toLowerCase()]
  })
  return (
    fields.includes('from') &&
    fields.includes('subject') &&
    (fields.includes('sent') || fields.includes('date'))
  )
}

function isCalendarHeader(lines: string[], index: number): boolean {
  if (!CALENDAR_LABEL.test(lines[index]!)) return false
  // An exact label followed by a provider URL, not prose merely containing one.
  const next = lines.slice(index + 1, index + 4).find((line) => line.trim() !== '')
  return next !== undefined && PROVIDER_LINK.test(next)
}

/** Keep authored prose unless an explicit, well-known boundary starts. */
export function cleanMailText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  let quotedBlock = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (
      QUOTE_START.test(line) &&
      /^\s*>/.test(lines.slice(index + 1).find((next) => next.trim() !== '') ?? '')
    ) {
      // A reply header establishes the following marked quote as history, not
      // all following prose: inline replies often resume after the quote.
      quotedBlock = true
      continue
    }
    if (FORWARD_START.test(line)) {
      if (isForwardBlock(lines, index)) break
      kept.push(line)
      continue
    }
    if (MOBILE_SIGNATURE.test(line)) continue
    if (SIGNATURE_DELIMITER.test(line)) {
      // A standard signature separator establishes only the next compact block.
      // Blank-separated prose and explicit postscripts are not part of it.
      let end = index + 1
      while (
        end < lines.length &&
        lines[end]!.trim() !== '' &&
        !POSTSCRIPT.test(lines[end]!) &&
        !QUOTE_START.test(lines[end]!) &&
        !FORWARD_START.test(lines[end]!)
      )
        end++
      index = end - 1
      continue
    }
    if (isCalendarHeader(lines, index)) {
      // Remove only the bounded, independently recognizable calendar lines.
      // Authored prose following the invite survives.
      let end = index + 1
      while (
        end < lines.length &&
        end <= index + 6 &&
        (lines[end]!.trim() === '' ||
          CALENDAR_LABEL.test(lines[end]!) ||
          PROVIDER_LINK.test(lines[end]!) ||
          CALENDAR_DETAIL.test(lines[end]!))
      )
        end++
      index = end - 1
      continue
    }
    if (quotedBlock && /^\s*>/.test(line)) continue
    // A standalone quote marker is not proof of reply history. Keep it unless
    // a recognized attribution header has established quoted context.
    kept.push(line)
  }
  return kept
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Gmail search snippets can contain preheader controls and HTML-escaped text. */
export function cleanSearchSnippet(text: string): string {
  // Keep malformed entity-like text intact; HTML's legacy parser otherwise
  // decodes a valid prefix such as `&not` inside `&not-a-name;`.
  const protectedText = text.replace(/&(?=[a-z][\w-]*-[\w-]*;)/gi, '&amp;')
  return decodeHTML(protectedText)
    .replace(INVISIBLE, '')
    .replace(/\u00a0/g, ' ')
    .trim()
}
