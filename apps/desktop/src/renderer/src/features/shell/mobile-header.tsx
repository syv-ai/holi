import { Button } from '@/components/ui/button'
import { atom, useAtomValue } from 'jotai'
import { installedPluginsAtom } from '@/state/plugins'
import { SheetTrigger } from '@/components/ui/sheet'
import { BrandMark } from '@/composites/brand-mark'
import { MenuIcon, SearchIcon, PlusIcon } from 'lucide-react'

const hiddenTitleBarItem = atom(false)

/** Below md the sidebar lives in a sheet, so this bar repeats its header
    and keeps search and a new document one tap away. */
export function MobileHeader({
  onOpenSearch,
  onNewDocument,
}: {
  onOpenSearch: () => void
  onNewDocument: () => void
}) {
  const titleBarItem = useAtomValue(installedPluginsAtom).find(
    (plugin) => plugin.titleBarItem,
  )?.titleBarItem
  const itemVisible = useAtomValue(titleBarItem?.visible ?? hiddenTitleBarItem)
  const TitleBarItem = itemVisible ? titleBarItem?.Component : undefined
  return (
    <div className="bg-background sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
      {/* The sheet's own trigger: it wires aria-expanded and gets focus back on close. */}
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Open sidebar">
          <MenuIcon aria-hidden="true" />
        </Button>
      </SheetTrigger>
      {TitleBarItem ? (
        <>
          <TitleBarItem />
          <span className="min-w-0 flex-1" />
        </>
      ) : (
        <>
          <BrandMark variant="monogram" className="h-5" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">Holi</span>
        </>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Search" onClick={onOpenSearch}>
        <SearchIcon aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="New document" onClick={onNewDocument}>
        <PlusIcon aria-hidden="true" />
      </Button>
    </div>
  )
}
