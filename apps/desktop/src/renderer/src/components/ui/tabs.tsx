"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/cn"
import { Tabs as TabsPrimitive } from "radix-ui"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

const tabsEntryVariants = cva(
  'group/tab relative flex h-full min-w-0 data-drop-before:before:bg-primary data-drop-before:before:absolute data-drop-before:before:inset-y-1.5 data-drop-before:before:-start-0.5 data-drop-before:before:w-0.5 data-drop-before:before:rounded-full data-drop-after:after:bg-primary data-drop-after:after:absolute data-drop-after:after:inset-y-1.5 data-drop-after:after:-end-0.5 data-drop-after:after:w-0.5 data-drop-after:after:rounded-full', {
  variants: {
    size: {
      tab: 'w-44 min-w-28',
      'tab-group': 'w-60 min-w-44',
      'tab-wide': 'w-80 min-w-60',
    },
  },
})

/** A strip entry owns its responsive width; its trigger fills the slot. */
function TabsEntry({
  className,
  size,
  ...props
}: React.ComponentProps<'div'> & { size: 'tab' | 'tab-group' | 'tab-wide' }) {
  return <div className={cn(tabsEntryVariants({ size }), className)} {...props} />
}

function TabsTrigger({
  className,
  variant = "default",
  ...props
}: Omit<React.ComponentProps<typeof TabsPrimitive.Trigger>, "size"> & {
  /** `tab` is a start-aligned trigger that fills its stock `TabsEntry` slot. */
  variant?: "default" | "tab"
}) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        variant === "tab" && "hover:bg-foreground/5 data-active:bg-foreground/8 dark:data-active:bg-foreground/8 data-[combine-preview]:bg-muted/40",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        variant === "tab" &&
          "flex-1 w-full min-w-0 justify-start gap-2 px-3 pe-8 after:hidden has-data-[tab-status]:pe-1.5",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, TabsEntry, tabsListVariants }
