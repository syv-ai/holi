import { Badge } from '@/components/ui/badge'
import { speakerName } from '../shared/meeting'

/** Who spoke, told apart at a glance: the microphone, the computer's sound
 *  (the other side of a call), or a numbered voice in the room. */
export function SpeakerBadge({ speaker }: { speaker: string }): React.JSX.Element {
  return (
    <Badge
      variant={speaker === 'Me' ? 'info-light' : speaker === 'Them' ? 'secondary' : 'outline'}
      className="shrink-0"
    >
      {speakerName(speaker)}
    </Badge>
  )
}
