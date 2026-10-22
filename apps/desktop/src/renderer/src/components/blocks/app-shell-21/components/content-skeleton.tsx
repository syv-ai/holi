import { cn } from "@/lib/cn"

import { Skeleton } from "@/components/ui/skeleton"

/** Turn shapes for the placeholder column: line widths only, no copy. */
const TURNS: { role: "user" | "assistant"; lines: string[] }[] = [
  { role: "user", lines: ["w-52"] },
  { role: "assistant", lines: ["w-full", "w-11/12", "w-2/3"] },
  { role: "user", lines: ["w-72", "w-36"] },
  { role: "assistant", lines: ["w-full", "w-full", "w-5/6", "w-1/2"] },
  { role: "user", lines: ["w-44"] },
  { role: "assistant", lines: ["w-full", "w-10/12", "w-3/5"] },
  { role: "user", lines: ["w-64"] },
]

export function ContentSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The column scrolls under the sticky header, the composer stays docked. */}
      <div className="scrollbar min-h-0 flex-1 overflow-y-auto">
        <div
          aria-hidden="true"
          className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 sm:px-6"
        >
          {TURNS.map((turn, index) =>
            turn.role === "user" ? (
              <div key={index} className="flex flex-col items-end gap-2">
                {turn.lines.map((width, line) => (
                  <Skeleton key={line} className={cn("h-8", width)} />
                ))}
              </div>
            ) : (
              <div key={index} className="flex gap-3">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-2">
                  {turn.lines.map((width, line) => (
                    <Skeleton key={line} className={cn("h-3.5", width)} />
                  ))}
                </div>
              </div>
            )
          )}
        </div>
      </div>

      <div aria-hidden="true" className="shrink-0 px-3 pb-4 sm:px-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="mx-auto h-3 w-64" />
        </div>
      </div>
    </div>
  )
}