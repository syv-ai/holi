/**
 * What a message is about besides its words: a vault app, attached as a chip
 * above the composer's text (a card's Ask about this app, or an app picked
 * from the `@` menu). Like a vault document, an app is not sent as its
 * contents: the message names its bundle as an `@` reference, which Claude
 * Code reads itself, in the clone, with its own permissions.
 */
import { useAtomValue } from "jotai"
import { AppWindowIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/reui/badge"
import { Button } from "@/components/ui/button"
import { surfacesAtom, type ConversationContext } from "@/plugin-api"
import { mentionValue } from "./composer-tokens"

export type { ConversationContext }

/** The line a message opens with for each app it carries. */
export function contextLine(item: ConversationContext): string {
  return `This is about the vault app “${item.name}”, the folder @${mentionValue(
    item.path
  )} (its page is index.html, its manifest app.yaml).`
}

/** The text Claude Code is sent: a line per context item, then the message. */
export function withContext(
  text: string,
  context: readonly ConversationContext[] | undefined
): string {
  if (context === undefined || context.length === 0) return text
  const lines = context.map(contextLine).join("\n")
  return text.trim() === "" ? lines : `${lines}\n\n${text}`
}

/** `next` added to `items`, once per path. */
export function addContext(
  items: readonly ConversationContext[],
  next: ConversationContext
): ConversationContext[] {
  return items.some((item) => item.path === next.path)
    ? [...items]
    : [...items, next]
}

/** The chips above the text: each app with its icon and name, and its own
 *  Remove. */
export function ContextTray({
  items,
  onRemove,
}: {
  items: readonly ConversationContext[]
  onRemove(path: string): void
}) {
  const Icon = useAtomValue(surfacesAtom).get("app")?.icon ?? AppWindowIcon
  if (items.length === 0) return null
  return (
    <ul
      className="flex w-full flex-wrap items-center gap-2"
      aria-label="Context"
      data-context=""
    >
      {items.map((item) => (
        <li key={item.path} className="relative flex items-center">
          <Badge variant="outline" className="max-w-56 pe-6">
            <Icon aria-hidden />
            <span className="min-w-0 truncate">{item.name}</span>
          </Badge>
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            aria-label={`Remove ${item.name}`}
            className="absolute -end-1.5 -top-1.5 rounded-full"
            onClick={() => onRemove(item.path)}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  )
}
