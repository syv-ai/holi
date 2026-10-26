import { useSyncExternalStore } from 'react'
import { Kbd, KbdGroup } from '@/components/ui/kbd'

const subscribeToPlatform = () => () => {}

/** The server has no navigator, so it renders Mac keys and the client corrects. */
/** Whether to draw Apple's key names. */
export function useIsApplePlatform() {
  return useSyncExternalStore(
    subscribeToPlatform,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => true,
  )
}

const APPLE_KEYS: Record<string, string> = {
  mod: '⌘',
  alt: '⌥',
  shift: '⇧',
}

const OTHER_KEYS: Record<string, string> = {
  mod: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
}

/** Menu shortcuts read as one compact string: ⌘⇧L on Apple, Ctrl+Shift+L elsewhere. */
export function useShortcutLabel(keys: readonly string[]) {
  const apple = useIsApplePlatform()
  const names = apple ? APPLE_KEYS : OTHER_KEYS

  return keys.map((key) => names[key] ?? key).join(apple ? '' : '+')
}

/** A shortcut as keys: `["mod", "K"]` is ⌘K on Apple, Ctrl K elsewhere. */
export function ShortcutKeys({ keys }: { keys: readonly string[] }) {
  const names = useIsApplePlatform() ? APPLE_KEYS : OTHER_KEYS

  return (
    <KbdGroup>
      {keys.map((key) => (
        <Kbd key={key}>{names[key] ?? key}</Kbd>
      ))}
    </KbdGroup>
  )
}
