/**
 * A task's words, every one editable: title, why, acceptance
 * criteria and open questions (each added, edited or removed), and owner.
 * Controlled: the card holds the draft, so Send can save it first.
 */
import { Plus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { IconButton } from '@/composites/icon-button'
import type { Card } from '../shared/meeting'

/** What a person edits of a card. */
export type CardDraft = Pick<Card, 'title' | 'why' | 'acceptance' | 'openQuestions'> & {
  owner: string
}

export const draftOf = (card: Card): CardDraft => ({
  title: card.title,
  why: card.why,
  acceptance: card.acceptance,
  openQuestions: card.openQuestions,
  owner: card.owner ?? '',
})

const Heading = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>
)

/** A list of text, each item edited, added or removed in place. */
export function ListField({
  title,
  item,
  add,
  items,
  badge,
  onChange,
}: {
  title: string
  /** One item's name, for its field and its remove button. */
  item: string
  add: string
  items: readonly string[]
  badge?: string
  onChange: (items: string[]) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Heading>{title}</Heading>
      <ul className="flex flex-col gap-1">
        {items.map((value, k) => (
          <li key={k} className="flex items-center gap-1">
            {badge !== undefined && (
              <Badge variant="warning" className="shrink-0">
                {badge}
              </Badge>
            )}
            <Input
              aria-label={`${item} ${k + 1}`}
              className="min-w-0 flex-1"
              value={value}
              onChange={(e) => onChange(items.map((x, j) => (j === k ? e.target.value : x)))}
            />
            <IconButton
              label={`Remove ${item.toLowerCase()} ${k + 1}`}
              size="icon-xs"
              onClick={() => onChange(items.filter((_x, j) => j !== k))}
            >
              <X aria-hidden />
            </IconButton>
          </li>
        ))}
      </ul>
      <Button
        variant="ghost"
        size="xs"
        className="self-start"
        onClick={() => onChange([...items, ''])}
      >
        <Plus aria-hidden />
        {add}
      </Button>
    </div>
  )
}

export function CardFields({
  draft,
  live,
  onChange,
}: {
  draft: CardDraft
  /** The meeting records: open questions can be asked now. */
  live: boolean
  onChange: (draft: CardDraft) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <Input
        aria-label="Title"
        value={draft.title}
        onChange={(e) => onChange({ ...draft, title: e.target.value })}
      />
      <Textarea
        aria-label="Why"
        placeholder="Why it matters"
        value={draft.why}
        onChange={(e) => onChange({ ...draft, why: e.target.value })}
      />
      <ListField
        title="Done when"
        item="Criterion"
        add="Add criterion"
        items={draft.acceptance}
        onChange={(acceptance) => onChange({ ...draft, acceptance })}
      />
      <ListField
        title="Open questions"
        item="Question"
        add="Add question"
        items={draft.openQuestions}
        {...(live ? { badge: 'Ask now' } : {})}
        onChange={(openQuestions) => onChange({ ...draft, openQuestions })}
      />
      <Input
        aria-label="Owner"
        placeholder="Owner"
        value={draft.owner}
        onChange={(e) => onChange({ ...draft, owner: e.target.value })}
      />
    </div>
  )
}
