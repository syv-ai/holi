import { useAtomValue, useStore } from 'jotai'
import { useEffect, useRef } from 'react'

import type { Request, RequestAtom } from '@/state/request'

/** The last request each store's owner answered, for owners that mount after
 *  the ask (`catchUp`). Keyed by store because a store starts numbering
 *  again from 1. */
const answered = new WeakMap<object, WeakMap<object, number>>()

/**
 * Answer each request made of `target` once (`state/request.ts`). Requests
 * made before this mounts are not answered, unless `catchUp` is set: then
 * the last one nobody answered still is, whenever its owner appears.
 *
 * `handler` runs with the latest state. Return `false` to leave the request
 * pending and be asked again on the next render, when what it waits for
 * (a row in the tree) may have arrived.
 */
export function useRequest<T extends object>(
  target: RequestAtom<T>,
  handler: (request: Request<T>) => void | false,
  { catchUp = false }: { catchUp?: boolean } = {},
): void {
  const store = useStore()
  const request = useAtomValue(target)
  const mountedAt = useRef(request?.seq ?? 0)

  // Every render, not on a dependency list: the handler is the latest one,
  // and the sequence number is what says whether there is anything to do.
  useEffect(() => {
    if (request === null) return
    const byAtom = answered.get(store) ?? new WeakMap<object, number>()
    answered.set(store, byAtom)
    const seen = catchUp ? (byAtom.get(target) ?? 0) : mountedAt.current
    if (request.seq <= seen) return
    if (handler(request) === false) return
    if (catchUp) byAtom.set(target, request.seq)
    else mountedAt.current = request.seq
  })
}
