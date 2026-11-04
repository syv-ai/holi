import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

/** What sits under the toolbar: the tab's scrolling content. `flush` runs
 *  it to the pane's edges, for a grid whose rows are the edge. */
export function PanelBody({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-auto',
        !flush && 'gap-4 px-4 py-4 lg:px-6',
      )}
    >
      {children}
    </div>
  )
}
