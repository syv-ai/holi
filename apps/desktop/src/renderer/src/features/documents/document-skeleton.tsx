import { Skeleton } from '@/components/ui/skeleton'

/** The page's shape while the document is read. */
export function DocumentSkeleton() {
  return (
    <div
      aria-label="Opening the document"
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-12 sm:px-16"
    >
      <Skeleton className="h-8 w-2/3" />
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </div>
  )
}
