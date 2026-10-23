/**
 * A region with nothing in it yet, as ReUI Pro's `empty-state-9` draws one: a
 * layered IconStack glyph, a title, a line under it and at most two actions,
 * centred in whatever it stands in for. The block takes no props and fills a
 * page (`min-h-[820px]`); this is the same markup driven by props, filling its
 * container instead, so a plugin's empty view can use it through
 * `@/components/reui`.
 *
 * Only actions that exist belong here: a region with nothing to do about it
 * passes none.
 */
import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { IconStack } from "@/components/reui/icon-stack"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/cn"

export interface IconStackEmptyAction {
  label: string
  onClick: () => void
  icon?: LucideIcon
  disabled?: boolean
}

export interface IconStackEmptyProps {
  /** The glyph on the stack's front layer. */
  icon: LucideIcon
  /** Why it is empty, in a few words. */
  title: ReactNode
  /** What lands here, or what to do. */
  description?: ReactNode
  /** The one thing to do about it. */
  action?: IconStackEmptyAction
  /** A second, quieter way out. */
  secondary?: IconStackEmptyAction
  /** `status` for a region that fills on its own; `alert` for a failure. */
  role?: "status" | "alert"
  className?: string
}

function ActionButton({
  action,
  variant,
}: {
  action: IconStackEmptyAction
  variant?: "outline"
}) {
  const Glyph = action.icon
  return (
    <Button
      type="button"
      variant={variant}
      disabled={action.disabled}
      onClick={action.onClick}
    >
      {Glyph !== undefined && (
        <Glyph data-icon="inline-start" aria-hidden="true" />
      )}
      {action.label}
    </Button>
  )
}

export function IconStackEmpty({
  icon: Glyph,
  title,
  description,
  action,
  secondary,
  role,
  className,
}: IconStackEmptyProps) {
  return (
    <div
      data-slot="icon-stack-empty"
      role={role}
      className={cn(
        "flex min-h-0 w-full flex-1 items-center justify-center px-4 py-8",
        className
      )}
    >
      <Empty className="w-full max-w-3xl flex-none gap-7 rounded-none border-0 bg-transparent p-0 md:p-0">
        <EmptyHeader className="max-w-120 items-center gap-6 text-center">
          <EmptyMedia className="mb-0">
            <IconStack aria-hidden="true">
              <Glyph strokeWidth="1.9" aria-hidden="true" />
            </IconStack>
          </EmptyMedia>

          <div className="flex flex-col items-center gap-2">
            <EmptyTitle className="text-2xl font-semibold tracking-tight">
              {title}
            </EmptyTitle>
            {description !== undefined && (
              <EmptyDescription className="max-w-104 text-sm/relaxed">
                {description}
              </EmptyDescription>
            )}
          </div>
        </EmptyHeader>

        {(action !== undefined || secondary !== undefined) && (
          <EmptyContent className="max-w-none items-center gap-0">
            <div className="flex w-full flex-wrap items-center justify-center gap-2">
              {action !== undefined && <ActionButton action={action} />}
              {secondary !== undefined && (
                <ActionButton action={secondary} variant="outline" />
              )}
            </div>
          </EmptyContent>
        )}
      </Empty>
    </div>
  )
}
