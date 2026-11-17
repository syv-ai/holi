/**
 * Opt-in protocol across the host/plugin-frame postMessage seam. The host sends
 * init once per presentation with a fresh nonce; the guest pins that message's
 * parent origin, then emits bounded snapshots/revisions. `start` requests the
 * host coordinator, which acknowledges a current revision with `session`; only
 * then are fixed hint keys and Escape/Backspace emitted. The host sends
 * `activate` with a current ID/revision, or `clear`/`disable`. Target identity,
 * labels and key interpretation stay with the guest DOM and host coordinator;
 * no plugin URL, code, capability, or arbitrary key crosses this protocol.
 */
const FRAME_HINT_LIMITS = {
  targets: 100,
  label: 160,
  id: 80,
  nonce: 128,
} as const

const FRAME_HINT_KEYS = 'asdfghjklqwertyuiopzxcvbnm'

export type FrameHintTarget = {
  id: string
  kind: 'button' | 'link' | 'summary'
  label: string
  x: number
  y: number
  width: number
  height: number
}

export type FrameHintsMessage =
  | { type: 'holi-hints:init'; nonce: string; enabled: true }
  | { type: 'holi-hints:disable'; nonce: string }
  | { type: 'holi-hints:snapshot'; nonce: string; revision: number; targets: FrameHintTarget[] }
  | { type: 'holi-hints:invalidated'; nonce: string; revision: number }
  | { type: 'holi-hints:start'; nonce: string; revision: number }
  | { type: 'holi-hints:key'; nonce: string; key: string }
  | { type: 'holi-hints:session'; nonce: string; revision: number; active: boolean }
  | { type: 'holi-hints:clear'; nonce: string; revision?: number }
  | { type: 'holi-hints:activate'; nonce: string; revision: number; id: string }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const boundedString = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const revision = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value)

function isFrameHintTarget(value: unknown): value is FrameHintTarget {
  if (!record(value) || !exact(value, ['id', 'kind', 'label', 'x', 'y', 'width', 'height']))
    return false
  return (
    boundedString(value.id, FRAME_HINT_LIMITS.id) &&
    (value.kind === 'button' || value.kind === 'link' || value.kind === 'summary') &&
    typeof value.label === 'string' &&
    value.label.length > 0 &&
    value.label.length <= FRAME_HINT_LIMITS.label &&
    ['x', 'y', 'width', 'height'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
    ) &&
    (value.width as number) > 0 &&
    (value.height as number) > 0
  )
}

/** Reject unknown keys, oversized arrays, duplicate IDs and malformed values. */
export function isFrameHintsMessage(value: unknown): value is FrameHintsMessage {
  if (
    !record(value) ||
    typeof value.type !== 'string' ||
    !boundedString(value.nonce, FRAME_HINT_LIMITS.nonce)
  )
    return false
  switch (value.type) {
    case 'holi-hints:init':
      return exact(value, ['type', 'nonce', 'enabled']) && value.enabled === true
    case 'holi-hints:disable':
      return exact(value, ['type', 'nonce'])
    case 'holi-hints:clear':
      return (
        exact(value, ['type', 'nonce']) ||
        (exact(value, ['type', 'nonce', 'revision']) && revision(value.revision))
      )
    case 'holi-hints:snapshot':
      if (!exact(value, ['type', 'nonce', 'revision', 'targets']) || !revision(value.revision))
        return false
      if (!Array.isArray(value.targets) || value.targets.length > FRAME_HINT_LIMITS.targets)
        return false
      return (
        value.targets.every(isFrameHintTarget) &&
        new Set(value.targets.map((target) => target.id)).size === value.targets.length
      )
    case 'holi-hints:invalidated':
    case 'holi-hints:start':
    case 'holi-hints:session':
      return (
        exact(
          value,
          value.type === 'holi-hints:session'
            ? ['type', 'nonce', 'revision', 'active']
            : ['type', 'nonce', 'revision'],
        ) &&
        revision(value.revision) &&
        (value.type !== 'holi-hints:session' || typeof value.active === 'boolean')
      )
    case 'holi-hints:key':
      return (
        exact(value, ['type', 'nonce', 'key']) &&
        typeof value.key === 'string' &&
        (value.key === 'Escape' ||
          value.key === 'Backspace' ||
          (value.key.length === 1 && FRAME_HINT_KEYS.includes(value.key)))
      )
    case 'holi-hints:activate':
      return (
        exact(value, ['type', 'nonce', 'revision', 'id']) &&
        revision(value.revision) &&
        boundedString(value.id, FRAME_HINT_LIMITS.id)
      )
    default:
      return false
  }
}
