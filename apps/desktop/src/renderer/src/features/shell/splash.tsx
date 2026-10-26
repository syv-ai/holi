import { BrandMark } from '@/composites'

/**
 * What the window shows while the app finds out where it stands: reading the
 * session from the keychain, then the vault list. The plain page, as sign-in
 * and the onboarding ritual have, so the hand-over to either is the content
 * changing and not the whole window flashing.
 */
export function Splash(): React.JSX.Element {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-6 bg-background text-foreground">
      <BrandMark size="lg" />
      <span
        role="status"
        aria-label="Loading"
        className="size-1.5 rounded-full bg-primary motion-pulse"
      />
    </div>
  )
}
