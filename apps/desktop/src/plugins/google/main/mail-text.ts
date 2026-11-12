/** Conservative text cleanup for the agent-facing Gmail CLI, not the reader. */
const INVISIBLE =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g

const decodeEntities = (text: string): string =>
  text
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, (entity) => {
      const entities: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
        '&nbsp;': ' ',
      }
      return entities[entity.toLowerCase()] ?? entity
    })
    .replace(/&#(x[\da-f]+|\d+);/gi, (entity, code: string) => {
      const point = code.toLowerCase().startsWith('x')
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10)
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity
    })

const QUOTE_START =
  /^\s*(?:On .{1,240} (?:wrote|schrieb|a écrit|escribió|ha scritto)\s*:|(?:Le|Am|El) .{1,240} (?:wrote|schrieb|a écrit|escribió)\s*:|[- ]{2,}Original Message[- ]*)\s*$/i
const FORWARD_START =
  /^\s*(?:-{2,}\s*(?:Forwarded message|Original Message)\s*-*|Begin forwarded message:|転送メッセージ)\s*$/i
const SIGNATURE_LINE =
  /^\s*(?:--\s*$|Sent from my (?:iPhone|iPad|Android|mobile device)\.?\s*$|Get Outlook for (?:iOS|Android)\s*$)/i
const CALENDAR_START =
  /^\s*(?:Join (?:with )?(?:Google Meet|Zoom Meeting|Microsoft Teams Meeting)|Join meeting|Meeting link\s*:|Video call link\s*:|Dial in\s*:|More phone numbers\s*:|Google Meet joining info)\b/i

/** Keep authored prose unless an explicit, well-known boundary starts. */
export function cleanMailText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (
      QUOTE_START.test(line) ||
      FORWARD_START.test(line) ||
      SIGNATURE_LINE.test(line) ||
      CALENDAR_START.test(line)
    )
      break
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
  return decodeEntities(text.replace(INVISIBLE, ''))
    .replace(/\u00a0/g, ' ')
    .trim()
}
