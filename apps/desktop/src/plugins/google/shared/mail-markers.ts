/** The mail marker catalogue used by the Google plugin's UI and main process. */
export const MAIL_MARKERS = ['yellow-star', 'red-star', 'blue-question'] as const
export type MailMarker = (typeof MAIL_MARKERS)[number]
export type MarkerValue = MailMarker | null

/** Ordered markers enabled for use in the mail surface. */
export interface MailMarkerPreferences {
  enabledOrder: MailMarker[]
}

/** The ordinary Gmail star remains enabled by default. */
export const DEFAULT_MAIL_MARKER_PREFERENCES: MailMarkerPreferences = {
  enabledOrder: ['yellow-star'],
}

/** Reject unknown and repeated markers, and restore the ordinary default if empty. */
export function normalizeMailMarkerPreferences(value: unknown): MailMarkerPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid mail marker preferences')
  }
  const enabledOrder = (value as { enabledOrder?: unknown }).enabledOrder
  if (!Array.isArray(enabledOrder) || enabledOrder.some((item) => !isMailMarker(item))) {
    throw new Error('invalid mail marker preferences')
  }
  if (new Set(enabledOrder).size !== enabledOrder.length) {
    throw new Error('duplicate mail marker preference')
  }
  return {
    enabledOrder:
      enabledOrder.length === 0
        ? [...DEFAULT_MAIL_MARKER_PREFERENCES.enabledOrder]
        : [...enabledOrder],
  }
}

export function isMailMarker(value: unknown): value is MailMarker {
  return typeof value === 'string' && (MAIL_MARKERS as readonly string[]).includes(value)
}
