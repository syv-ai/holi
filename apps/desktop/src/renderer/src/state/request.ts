/**
 * A request one part of the app makes of another that owns the answer: open
 * this document, reveal that row, show Settings. The asker writes it with
 * `raise`, which numbers it so the same payload can be asked twice; the owner
 * answers each number once with `useRequest` (`hooks/use-request.ts`).
 */
import { atom, type Getter, type PrimitiveAtom, type Setter } from 'jotai'

/** A payload and the number of the ask that carried it. */
export type Request<T extends object> = T & { seq: number }

/** The last request made, or null before the first. */
export type RequestAtom<T extends object> = PrimitiveAtom<Request<T> | null>

export function requestAtom<T extends object>(): RequestAtom<T> {
  return atom<Request<T> | null>(null)
}

/** Make a request: the next number after the last one. */
export function raise<T extends object>(
  get: Getter,
  set: Setter,
  target: RequestAtom<T>,
  payload: T,
): void {
  set(target, { ...payload, seq: (get(target)?.seq ?? 0) + 1 })
}
