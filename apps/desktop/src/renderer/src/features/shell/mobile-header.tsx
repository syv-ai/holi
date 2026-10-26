import { Button } from "@/components/ui/button"
import { SheetTrigger } from "@/components/ui/sheet"
import { BrandMark } from "@/composites/brand-mark"
import { MenuIcon, SearchIcon, PlusIcon } from "lucide-react"

/** Below md the thread sidebar lives in a sheet, so this bar repeats its header
    and keeps search and a new chat one tap away. */
export function MobileHeader({
  onOpenSearch,
  onNewChat,
}: {
  onOpenSearch: () => void
  onNewChat: () => void
}) {
  return (
    <div className="bg-background sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
      {/* The sheet's own trigger: it wires aria-expanded and gets focus back on close. */}
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Open chats">
          <MenuIcon aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <BrandMark variant="monogram" className="h-5" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
        Holi
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Search chats"
        onClick={onOpenSearch}
      >
        <SearchIcon aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="New chat"
        onClick={onNewChat}
      >
        <PlusIcon aria-hidden="true" />
      </Button>
    </div>
  )
}