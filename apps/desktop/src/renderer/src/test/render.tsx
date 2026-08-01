import { render as rtlRender, type RenderOptions } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { TooltipProvider } from '@/primitives'

/**
 * The app mounts a single TooltipProvider at its root (main.tsx); component tests
 * must mirror that or any tooltip trigger throws. This custom render wraps every
 * subject in the same ambient providers — import `render` from here instead of
 * from @testing-library/react. `delayDuration={0}` so a tooltip is assertable
 * without waiting.
 */
function Providers({ children }: { children: ReactNode }): React.JSX.Element {
  return <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
}

export function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return rtlRender(ui, { wrapper: Providers, ...options })
}

export * from '@testing-library/react'
