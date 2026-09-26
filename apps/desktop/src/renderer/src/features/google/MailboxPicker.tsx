/**
 * The one control that says which mail you are looking at.
 *
 * The *places* live in this picker and the *state* stays outside it:
 *
 * - **A place** is where you are: the inbox, one of Gmail's tabs, Sent,
 *   Drafts. Exactly one at a time, which is what a dropdown expresses.
 * - **A state** is how you are looking at a place: unread only. It is
 *   orthogonal to every place, so folding it in would double the menu.
 *
 * **Drafts and Sent sit below a separator, not among the tabs.** Gmail's tabs
 * are subdivisions of one inbox; these two are different mailboxes.
 *
 * Unread counts appear only on the inbox entries. Sent and Drafts get nothing,
 * not a zero, because they have no unread state at all.
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
 * Where the list is pointed. A union rather than independent flags, which
 * could express "Drafts, filtered to Promotions", a place that does not exist.
 */
export type MailboxView =
  { kind: 'category'; category: MailCategory | null } | { kind: 'sent' } | { kind: 'drafts' }

/**
 * Gmail's tabs, plus the default: no tab at all.
 *
 * **`null` is first and is the default, deliberately.** `category:primary`
 * matches nothing unless the account actually *uses* inbox categories, and any
 * non-Default inbox layout (Priority Inbox, Multiple Inboxes, Important-first)
 * switches them off. The tabs are offered, not assumed.
 *
 * This is also why per-tab unread counts can sum to less than the inbox's own
 * unread total: on an account that does not use tabs, `category:primary`
 * matches nothing while Gmail still labels Promotions and Updates.
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

/** What the trigger says. */
export function mailboxLabelOf(view: MailboxView): string {
  if (view.kind === 'sent') return 'Sent'
  if (view.kind === 'drafts') return 'Drafts'
  return CATEGORIES.find((c) => c.value === view.category)?.label ?? 'All mail'
}

/**
 * What a *thread* may say about the tab it arrived in, reusing the picker's own
 * labels so a row chip and a menu entry cannot drift apart.
 *
 * `null` in, `null` out, deliberately not "All mail": otherwise every row of an
 * account that does not use tabs would get a chip.
 */
export function categoryLabelOf(category: MailCategory | null): string | null {
  if (category === null) return null
  return CATEGORIES.find((c) => c.value === category)?.label ?? null
}

/** The union flattened to a string a menu item can key and compare on. */
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
  /** The whole inbox's unread, which is what "All mail" means here. */
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
    // Not tabs but mailboxes, hence the separator above them in the menu.
    { view: { kind: 'sent' }, label: 'Sent', badge: '' },
    { view: { kind: 'drafts' }, label: 'Drafts', badge: '' },
  ]

  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      {/* Short on purpose. The "tabs only apply if your inbox uses them"
          caveat lives in the empty-state message for a tab. */}
      <Tooltip content="choose a mailbox">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className="gap-1" aria-label="choose a mailbox">
            {mailboxLabelOf(view)}
            {/* The chevron makes this read as a menu, not a clickable label. */}
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
                {/* Nothing rather than a zero while counts are in flight or a
                    request failed: absent means "not known". */}
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

/** The number beside one tab, or `''` when it is not known. A known `0` is
 *  rendered, since a blank would read as "still loading". */
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
