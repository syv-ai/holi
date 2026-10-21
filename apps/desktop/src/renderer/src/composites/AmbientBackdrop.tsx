import { useSyncExternalStore } from 'react'
import { cn } from '@/lib/cn'
import { SideRays } from './SideRays'

/** The light's two colours: warm sun into a cool sky, as the shader takes them. */
const WARM = '#FFC46B'
const COOL = '#96c8ff'

/**
 * The light behind the screens shown before a vault opens (sign-in, loading,
 * the onboarding ritual): shafts of warm light falling in from the top-left
 * corner and shifting slowly (`SideRays`), over the plain page colour. The
 * one decorative loop the app allows (`docs/ui-system.md`).
 *
 * Fills its nearest positioned ancestor and takes no pointer events, so the
 * holder puts it first inside a `relative isolate` box and lays content above.
 * The grain is separate (`AmbientGrain`) and goes last, over the content: a
 * `GlassPanel` bends whatever is behind it, and grain bent by the glass smears
 * into streaks.
 */
export function AmbientBackdrop({ className }: { className?: string }): React.JSX.Element {
  const light = useRootTheme() === 'light'
  return (
    <div aria-hidden="true" className={cn('ambient-backdrop', className)}>
      <SideRays
        rayColor1={WARM}
        rayColor2={COOL}
        origin="top-left"
        speed={0.9}
        intensity={0.5}
        spread={3.85}
        density={1}
        followMouse={false}
        blend={0.76}
        sharpness={0}
        tilt={-12}
        falloff={0.5}
        glow={1}
        saturation={1}
        dust={0}
        mouseInfluence={0.5}
        intro={false}
        lightMode={light}
        opacity={1}
      />
    </div>
  )
}

/** Film grain over the whole screen, content included; the last child of the
 *  same `relative isolate` box as the backdrop. */
export function AmbientGrain(): React.JSX.Element {
  return <div aria-hidden="true" className="ambient-grain" />
}

/** The `data-theme` stamp on the root, live: the rays draw differently on
 *  light paper, and the stamp is the one place the mode in force is written. */
function useRootTheme(): string | undefined {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange)
      observer.observe(document.documentElement, { attributeFilter: ['data-theme'] })
      return () => observer.disconnect()
    },
    () => document.documentElement.dataset.theme,
  )
}
