import { type ReactNode, type Ref } from "react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PanelLeftIcon } from "lucide-react"

/**
 * The window's one top band, after MonoCode and Superset: the traffic lights,
 * the sidebar's own controls over the sidebar, and the view's header (the
 * tabs) beside them, with a hairline under all of it. Open, the lead matches
 * the sidebar's width, so its divider runs on from the resize handle below;
 * collapsed, it shrinks to the lights and the toggle.
 */
/**
 * The lead's width for a sidebar this wide. The resize handle is a 1px line
 * after the panel, and the lead's divider is its own last pixel, so the lead
 * runs a pixel past the sidebar to put the two in one line.
 */
export function leadWidth(sidebarWidth: number) {
  return sidebarWidth + 1
}

export function TitleBar({
  sidebarOpen,
  sidebarWidth,
  leadRef,
  onToggleSidebar,
  children,
}: {
  sidebarOpen: boolean
  sidebarWidth: number
  /** Resized by the shell as the sidebar moves, without a render. */
  leadRef: Ref<HTMLDivElement>
  onToggleSidebar: () => void
  children: ReactNode
}) {
  return (
    <header
      data-slot="app-chrome"
      className="app-drag flex h-11 shrink-0 items-center border-b"
    >
      <div
        ref={leadRef}
        data-window-band="lights"
        data-open={sidebarOpen || undefined}
        style={sidebarOpen ? { width: leadWidth(sidebarWidth) } : undefined}
        className="group/lead data-open:border-e flex h-full shrink-0 items-center gap-1 overflow-hidden px-2"
      >
        {/* Open, the toggle rides the divider (and so follows a resize);
            collapsed, it sits by the traffic lights. Off the attribute the
            shell flips mid-toggle, so it moves with the motion. */}
        <div className="hidden flex-1 group-data-open/lead:block" />
        <BandButton
          label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          onClick={onToggleSidebar}
        >
          <PanelLeftIcon aria-hidden="true" />
        </BandButton>
      </div>
      {children}
    </header>
  )
}

function BandButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
