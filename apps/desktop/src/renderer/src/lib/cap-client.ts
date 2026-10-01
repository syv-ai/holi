/**
 * The renderer's side of the capability UI door (docs/architecture.md,
 * Plugins): a typed client over `cap.run` for one namespace.
 *
 *   const pdf = capClient<typeof pdfCapabilities>('pdf')
 *   const templates = await pdf.templates(remote)
 *
 * The table is a type-only import from the main side, so nothing of main is
 * bundled here. Only verbs whose entry opens the `ui` door are offered, with
 * params and result inferred from the entry. Write the table with
 * `satisfies CapabilityTable`, not as an annotation, or its doors and types
 * widen away. Params cross as JSON; results cross IPC by structured clone, so
 * a result must be structured-clonable (plain data, `Uint8Array`, `Date`).
 * Main refuses whatever this type gets wrong.
 */
import type { Door } from '../../../main/capabilities/registry'
import { trpc } from './trpc'

interface UiEntry {
  doors: readonly Door[]
  params(raw: unknown): unknown
  run(...args: never[]): Promise<unknown>
}

/** Whether a caller may leave the params out: the entry takes none, or none
 *  it requires. */
type Omittable<P> = undefined extends P
  ? true
  : null extends P
    ? true
    : Record<string, never> extends P
      ? true
      : false

/** What an entry's `run` resolves to. Not `ReturnType`, which reads a
 *  `run(...args: never[])` (a hand-typed `UiCapability`'s) as `any`. */
type Result<E extends UiEntry> = E['run'] extends (...args: never[]) => infer R ? Awaited<R> : never

/** One verb: the vault it runs in, then its params. */
type Verb<E extends UiEntry> =
  Omittable<ReturnType<E['params']>> extends true
    ? (remote: string, params?: ReturnType<E['params']>) => Promise<Result<E>>
    : (remote: string, params: ReturnType<E['params']>) => Promise<Result<E>>

/**
 * The verbs of `T` that open the UI door, keyed by the part after the
 * namespace. `T` is one namespace's table.
 */
export type CapClient<T> = {
  [
    K in keyof T & string as K extends `${string}.${infer V}`
      ? T[K] extends UiEntry
        ? 'ui' extends T[K]['doors'][number]
          ? V
          : never
        : never
      : never
  ]: T[K] extends UiEntry ? Verb<T[K]> : never
}

/**
 * One UI-door verb as a caller types it by hand: another plugin's capability,
 * whose table it does not import. Dispatch checks the params at runtime.
 *
 *   capClient<{ 'tasks.create': UiCapability<{ title: string }, { path: string }> }>('tasks')
 */
export interface UiCapability<P, R> {
  doors: readonly ['ui']
  params(raw: unknown): P
  run(...args: never[]): Promise<R>
}

export function capClient<T>(namespace: string): CapClient<T> {
  return new Proxy({} as CapClient<T>, {
    get: (_target, verb) =>
      // Not `then`: an awaited client must not read as a promise.
      typeof verb !== 'string' || verb === 'then'
        ? undefined
        : (remote: string, params?: unknown) =>
            trpc.cap.run.mutate({
              remote,
              name: `${namespace}.${verb}`,
              paramsJson: params === undefined ? undefined : JSON.stringify(params),
            }),
  })
}
