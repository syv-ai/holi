/**
 * The chips for mail/calendar links found in a body. A composite so more
 * than one feature can use it.
 *
 * No state of its own: the links live in the body text, with no frontmatter
 * field or index, so deleting the markdown link removes the chip.
 */
import { CalendarDays, Mail } from 'lucide-react'
import { googleLinksIn, type GoogleLinkKind } from '@holi/shared'
import { Button, Icon, Tooltip } from '@/primitives'

const ICON = { calendar: CalendarDays, mail: Mail } as const
const WHAT: Record<GoogleLinkKind, string> = {
  calendar: 'open the event in Google Calendar',
  mail: 'open the thread in Gmail',
}

export function GoogleLinkChips({ body }: { body: string }) {
  const links = googleLinksIn(body)
  if (links.length === 0) return null

  return (
    <div className="mb-3 flex flex-wrap gap-1.5 px-1">
      {links.map((link, i) => {
        return (
          <Tooltip key={`${link.url}:${i}`} content={WHAT[link.kind]}>
            <Button
              variant="secondary"
              size="xs"
              className="max-w-xs gap-1.5"
              onClick={() => void window.holi.openExternal(link.url)}
            >
              <Icon icon={ICON[link.kind]} size="sm" />
              {/* The link text as written — normally the subject or event title. */}
              <span className="truncate">{link.title === '' ? link.url : link.title}</span>
            </Button>
          </Tooltip>
        )
      })}
    </div>
  )
}
