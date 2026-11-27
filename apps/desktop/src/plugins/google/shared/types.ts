/** Renderer-safe mail attention state. No message content or credentials cross the seam. */
export interface MailAttentionSnapshot {
  /** The connected Google identity, or null while this vault is disconnected. */
  accountSub: string | null
  /** Gmail's exact unread INBOX thread count; null means it is not known. */
  unreadThreads: number | null
  /** `stale` retains the last exact count after a failed refresh. */
  status: 'disconnected' | 'unknown' | 'fresh' | 'stale'
  /** Monotonic within one vault activation, for event/snapshot reconciliation. */
  revision: number
  /** When the exact count was last fetched successfully. */
  updatedAt: string | null
}

/** Full snapshot event sent to Google's renderer side. */
export const MAIL_ATTENTION_EVENT = 'mail-attention-changed'

/** Native-notification navigation event for the originating vault. */
export const OPEN_MAIL_EVENT = 'open-mail'
