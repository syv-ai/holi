/**
 * The one control that says which mail you are looking at.
 *
 * There used to be three, and they did not agree with each other: a Mail/Drafts
 * button pair, a category dropdown, and an unread toggle — each a different
 * shape, each in a different place, and between them there was still no way to
 * reach Sent. A user asking "where is what I sent?" had nowhere to look.
 *
 * So the *places* collapse into this picker and the *state* stays outside it.
 * That split is the reason the merge works rather than just being tidier:
 *
 * - **A place** is where you are — the inbox, one of Gmail's tabs, Sent,
 *   Drafts. Exactly one at a time, which is what a dropdown expresses.
 * - **A state** is how you are looking at a place — unread only. It is
 *   orthogonal to every place, so folding it in would have produced a menu with
 *   twelve entries that were really six times two.
 *
 * **Drafts and Sent sit below a separator, not among the tabs.** Gmail's tabs
 * are subdivisions of one inbox; these two are different mailboxes. Listing
 * them flush would say they are the same kind of thing, and the first question
 * that follows is why "Sent" has no unread count.
 *
 * The counts stay on the six tabs for the reason in [[MailView]]'s
 * `CategoryPicker` note, now inherited here: unread is what a tab badge means.
 * Sent and Drafts get nothing — not a zero, which would be a claim about
 * something that has no unread state at all.
 */
import { ChevronDown } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '@/primitives'

/** Mirrors `main/google/gmail.ts`. */
export type MailCategory = 'primary' | 'social' | 'promotions' | 'updates' | 'forums'

/**
 * Where the list is pointed.
 *
 * A union rather than two independent flags. The previous shape — a `category`
 * and a `showDrafts` boolean that had to be read together — could express
 * "Drafts, filtered to Promotions", which is not a place that exists, and the
 * code had to keep remembering that one of the two won.
 */
export type MailboxView =
  { kind: 'category'; category: MailCategory | null } | { kind: 'sent' } | { kind: 'drafts' }

/**
 * Gmail's tabs, plus the default: no tab at all.
 *
 * **`null` is first and is the default, deliberately.** `category:primary`
 * matches nothing unless the account actually *uses* inbox categories, and any
 * non-Default inbox layout — Priority Inbox, Multiple Inboxes, Important-first
 * — switches them off. Defaulting to Primary emptied a real inbox
 * ("Email view says No threads"). The tabs are offered; they are not assumed.
 *
 * This is also why per-tab unread counts can sum to less than the inbox's own
 * unread total, which looks like a bug and is not: on an account that does not
 * use tabs, `category:primary` matches nothing while Gmail still labels
 * Promotions and Updates.
 */
export const CATEGORIES: { value: MailCategory | null; label: string }[] = [
  { value: null, label: 'All mail' },
  { value: 'primary', label: 'Primary' },
  { value: 'social', label: 'Social' },
  { value: 'promotions', label: 'Promotions' },
  { value: 'updates', label: 'Updates' },
  { value: 'forums', label: 'Forums' },
]

/** Mirrors `CategoryCount` in `main/google/gmail.ts`. `more` means the answer
 *  ran past one page, so it renders as `500+` rather than as a number that
 *  quietly means "at least". */
export interface CategoryCount {
  count: number
  more: boolean
}

export type CategoryCounts = Partial<Record<MailCategory, CategoryCount | null>>

/** What the trigger says. The label is the whole affordance — a picker showing
 *  nothing useful is a button that has to be opened to be understood. */
export function mailboxLabelOf(view: MailboxView): string {
  if (view.kind === 'sent') return 'Sent'
  if (view.kind === 'drafts') return 'Drafts'
  return CATEGORIES.find((c) => c.value === view.category)?.label ?? 'All mail'
}

/**
 * What a *thread* may say about the tab it arrived in, reusing the picker's own
 * labels so a chip on a row and an entry in this menu cannot drift apart.
 *
 * `null` in, `null` out — deliberately not "All mail". On a row, `null` means
 * the thread carries no `CATEGORY_*` label at all; "All mail" is a *place* you
 * can point the list at. Naming the absence of a tab after the view that shows
 * every tab would put a chip on every row of an account that does not use them.
 */
export function categoryLabelOf(category: MailCategory | null): string | null {
  if (category === null) return null
  return CATEGORIES.find((c) => c.value === category)?.label ?? null
}

/** Same identity as the union, flattened to something a menu item can key and
 *  compare on. */
function idOf(view: MailboxView): string {
  return view.kind === 'category' ? `category:${view.category ?? 'all'}` : view.kind
}

export function MailboxPicker({
  view,
  onChange,
  counts,
  inboxUnread,
  onOpen,
}: {
  view: MailboxView
  onChange: (view: MailboxView) => void
  counts: CategoryCounts | null
  /** The whole inbox's unread, which is what "All mail" means here. Already in
   *  hand from `mailCounts`, so it costs nothing. */
  inboxUnread: number | null
  /** Called when the menu opens, so the five per-tab counts are paid for only
   *  by someone who actually looked. */
  onOpen: () => void
}): React.JSX.Element {
  const current = idOf(view)

  const entries: { view: MailboxView; label: string; badge: string }[] = [
    ...CATEGORIES.map((option) => ({
      view: { kind: 'category', category: option.value } as MailboxView,
      label: option.label,
      badge: unreadLabel(option.value, counts, inboxUnread),
    })),
    // Not a tab. A mailbox — hence the separator above them in the menu.
    { view: { kind: 'sent' }, label: 'Sent', badge: '' },
    { view: { kind: 'drafts' }, label: 'Drafts', badge: '' },
  ]

  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      {/* Short on purpose. This used to carry the "Gmail's tabs only apply if
          your inbox uses them" caveat, which was right when the control was
          only tabs and is wrong now that Sent and Drafts are in it. The caveat
          still gets said where it actually helps — in the empty-state message
          for a tab that came back with nothing. */}
      <Tooltip content="choose a mailbox">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className="gap-1" aria-label="choose a mailbox">
            {mailboxLabelOf(view)}
            {/* The chevron is what makes this read as a menu rather than as a
                label that happens to be clickable. */}
            <ChevronDown size={12} className="text-muted-foreground" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start">
        {entries.map((entry, index) => (
          <div key={idOf(entry.view)}>
            {/* Above Sent: everything before it is a subdivision of one inbox,
                everything from here is a different mailbox. */}
            {entry.view.kind === 'sent' && index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={() => onChange(entry.view)}
              aria-current={idOf(entry.view) === current}
            >
              <span className="flex w-full items-baseline justify-between gap-4">
                <span>{entry.label}</span>
                {/* Nothing at all rather than a zero while the counts are in
                    flight, or when one tab's request failed: an absent number
                    says "not known", and `0` would say "nothing here". */}
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {entry.badge}
                </span>
              </span>
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The number beside one tab, or `''` when there is nothing truthful to put
 *  there. `0` is rendered — "nothing unread" is a real answer, and a blank
 *  would read as "still loading". */
export function unreadLabel(
  value: MailCategory | null,
  counts: CategoryCounts | null,
  inboxUnread: number | null,
): string {
  if (value === null) return inboxUnread === null ? '' : String(inboxUnread)
  const count = counts?.[value]
  if (count === undefined || count === null) return ''
  return count.more ? `${count.count}+` : String(count.count)
}
