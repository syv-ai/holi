import { createContext, useContext, useLayoutEffect, useState, type ComponentProps } from 'react'

import { DropdownMenu } from '@/components/ui/dropdown-menu'
import { Popover } from '@/components/ui/popover'
import { PeopleStack } from '@/composites/person-avatar'

/** Whether the retained Planning tab is currently displayed in the workspace. */
export const PlanningVisibilityContext = createContext(true)

export function usePlanningVisible(): boolean {
  return useContext(PlanningVisibilityContext)
}

/** Closes a portaled menu while its retained owner is parked. */
export function PlanningDropdownMenu({
  children,
  onOpenChange,
  ...props
}: ComponentProps<typeof DropdownMenu>) {
  const visible = usePlanningVisible()
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])
  return (
    <DropdownMenu
      {...props}
      open={visible && open}
      onOpenChange={(next) => {
        setOpen(next)
        onOpenChange?.(next)
      }}
    >
      {children}
    </DropdownMenu>
  )
}

/** Closes a portaled picker while preserving its owner's draft state. */
export function PlanningPopover({
  children,
  open: controlledOpen,
  onOpenChange,
  ...props
}: ComponentProps<typeof Popover>) {
  const visible = usePlanningVisible()
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  useLayoutEffect(() => {
    if (!visible) {
      setInternalOpen(false)
      if (controlledOpen !== undefined) onOpenChange?.(false)
    }
  }, [visible, controlledOpen, onOpenChange])
  return (
    <Popover
      {...props}
      open={visible && open}
      onOpenChange={(next) => {
        if (controlledOpen === undefined) setInternalOpen(next)
        onOpenChange?.(next)
      }}
    >
      {children}
    </Popover>
  )
}

/** People overflow popovers close with their retained Planning owner. */
export function PlanningPeopleStack(props: ComponentProps<typeof PeopleStack>) {
  const visible = usePlanningVisible()
  return <PeopleStack {...props} visible={visible} />
}
