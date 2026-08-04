/**
 * The chips for mail/calendar links found in a body (D67).
 *
 * A **composite**, not a feature, for a structural reason: both the task editor
 * and (later) note surfaces want it, and a feature may not import another
 * feature. It needs nothing but primitives and a pure function from
 * `@holi/shared`, which is exactly what this layer is for.
 *
 * It renders **nothing of its own state**. The links live in the body text; this
 * is a view of them. That is the whole representation decision — no frontmatter
 * field, no index, no write-back — so deleting the markdown link in the body is
 * how you remove the chip.
 */
import { CalendarDays, Mail } from 'lucide-react'
import { googleLinksIn, type GoogleLinkKind } from '@holi/shared'
import { Button, Tooltip } from '@/primitives'

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
        const Icon = ICON[link.kind]
        return (
          <Tooltip key={`${link.url}:${i}`} content={WHAT[link.kind]}>
            <Button
              variant="secondary"
              size="xs"
              className="max-w-xs gap-1.5"
              onClick={() => void window.holi.openExternal(link.url)}
            >
              <Icon size={12} className="shrink-0" />
              {/* The link text as written — normally the subject or event title. */}
              <span className="truncate">{link.title === '' ? link.url : link.title}</span>
            </Button>
          </Tooltip>
        )
      })}
    </div>
  )
}
