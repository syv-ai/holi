import type { LucideIcon } from "lucide-react"
import { FileTextIcon, InboxIcon, SendIcon, StarIcon } from "lucide-react"

/**
 * The places the rail offers, each one Gmail answers for: the inbox, starred
 * (Gmail's `is:starred`), Sent and Drafts. The block's Archive, Spam and
 * Trash are left out: the list reads through the inbox-or-sent cache, and
 * Holi lists neither spam nor trash.
 */
export type MailFolder = "inbox" | "starred" | "sent" | "drafts"

export type MailNavFolder = {
  id: MailFolder
  label: string
  icon: LucideIcon
}

export const NAV_FOLDERS: MailNavFolder[] = [
  { id: "inbox", label: "Inbox", icon: InboxIcon },
  { id: "starred", label: "Starred", icon: StarIcon },
  { id: "sent", label: "Sent", icon: SendIcon },
  { id: "drafts", label: "Drafts", icon: FileTextIcon },
]

/**
 * Gmail's tabs inside the inbox. `null` (the whole inbox) is the default:
 * `category:primary` matches nothing on an inbox that does not use tabs.
 */
export const CATEGORIES = [
  { value: null, label: "All tabs" },
  { value: "primary", label: "Primary" },
  { value: "social", label: "Social" },
  { value: "promotions", label: "Promotions" },
  { value: "updates", label: "Updates" },
  { value: "forums", label: "Forums" },
] as const

/** Initials for an avatar: two letters of a name, else of an address. */
export function initialsOf(name: string, email = ""): string {
  const source = name.trim() !== "" ? name : email
  const words = source
    .replace(/[<>"']/g, "")
    .split(/[\s@._-]+/)
    .filter((word) => word !== "")
  const letters =
    words.length >= 2
      ? words[0]![0]! + words[1]![0]!
      : (words[0] ?? "?").slice(0, 2)
  return letters.toUpperCase()
}

/** Bytes as a person reads them. */
export function fileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
