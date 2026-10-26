export interface ActivityItem {
  /** Unique within the feed. */
  id: number
  actor: string
  action: string
  target: string
  /** The target's vault path, when it can be opened. */
  path?: string
  /** As shown: "3 hours ago". */
  date: string
  /** ISO, for the `<time>`. */
  dateTime: string
}
