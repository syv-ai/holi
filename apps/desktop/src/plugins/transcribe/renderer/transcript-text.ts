/** The transcript as text to paste: one `[m:ss] Speaker: text` line each. */
import { speakerName, type Segment } from '../shared/meeting'
import { clock } from '../shared/scribe-prompt'

export function transcriptText(segments: readonly Segment[]): string {
  return segments
    .map((s) => `[${clock(s.start)}] ${speakerName(s.speaker)}: ${s.text.trim()}`)
    .join('\n')
}
