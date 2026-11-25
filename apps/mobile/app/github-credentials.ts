import {
  authorizeWithGitHub,
  type DeviceAuthOptions,
  type DeviceAuthorization,
  createCancellation,
} from './device-auth'

export type CredentialStore = {
  read(): string | null
  write(token: string): void
  remove(): void
}

const keychainOperations = ['read', 'write', 'remove', 'metadata'] as const
export type KeychainOperation = (typeof keychainOperations)[number]

export class KeychainError extends Error {
  readonly #operation: KeychainOperation
  readonly #status: number

  constructor(operation: KeychainOperation, status: number) {
    super('iOS Keychain operation failed')
    this.#operation = operation
    this.#status = status
  }

  static diagnostic(error: unknown) {
    if (typeof error !== 'object' || error === null || !(#operation in error)) return
    const operation = error.#operation
    const status = error.#status
    if (
      !keychainOperations.includes(operation) ||
      !Number.isInteger(status) ||
      status < -2147483648 ||
      status > 2147483647
    )
      return
    return { kind: 'keychain' as const, operation, status }
  }
}

function storageError(error: unknown, operation: KeychainOperation, fallback: string): Error {
  const details = KeychainError.diagnostic(error)
  // Do not carry any adapter-provided message, cause or stack across the seam.
  return details?.operation === operation
    ? new KeychainError(operation, details.status)
    : new Error(fallback)
}

type Authorization = DeviceAuthorization & { wait(): Promise<void> }

// Holi manages one GitHub credential slot. Rebuilding its adapter must not reset
// authorization state: a stale handle could otherwise write after sign-out.
let generation = 0
let active: (() => void) | undefined

/** Opens a handle to the app's single GitHub credential slot. */
export function createGitHubCredentials(store: CredentialStore) {
  return {
    readToken(): string | null {
      try {
        return store.read()
      } catch (error) {
        throw storageError(error, 'read', 'Could not read GitHub credential')
      }
    },

    async authorize(options: DeviceAuthOptions): Promise<Authorization> {
      const externalSignal = options.signal
      const controller = createCancellation()
      const signal = controller.signal
      const current = ++generation
      const cancelled = () => current !== generation || signal.aborted
      const cleanup = () => {
        if (active === cancel) active = undefined
        try {
          externalSignal?.removeEventListener('abort', cancel)
        } catch {
          // A caller's signal adapter cannot veto local revocation or hide a storage failure.
        }
      }
      const cancel = () => {
        if (active === cancel) active = undefined
        controller.abort()
        cleanup()
      }
      // Abort listeners run synchronously and may authorize again. Publish the
      // replacement before notifying them and leave any newer owner untouched.
      const previous = active
      active = cancel
      previous?.()
      let session
      try {
        if (!cancelled()) {
          externalSignal?.addEventListener('abort', cancel)
          if (externalSignal?.aborted) cancel()
          const request = { ...options, signal }
          if (!cancelled()) session = await authorizeWithGitHub(request)
        }
      } catch {
        cleanup()
        if (cancelled()) throw new Error('Authorization cancelled')
        throw new Error('GitHub authorization failed')
      }
      if (!session || cancelled()) {
        cleanup()
        throw new Error('Authorization cancelled')
      }
      let used = false
      return {
        userCode: session.userCode,
        verificationUri: session.verificationUri,
        expiresIn: session.expiresIn,
        wait: async () => {
          if (used) throw new Error('Authorization has already been awaited')
          used = true
          try {
            let token: string
            try {
              token = await session.wait()
            } catch {
              throw new Error(
                cancelled() ? 'Authorization cancelled' : 'GitHub authorization failed',
              )
            }
            if (cancelled()) throw new Error('Authorization cancelled')
            try {
              store.write(token)
            } catch (error) {
              throw storageError(error, 'write', 'Could not save GitHub credential')
            }
          } finally {
            cleanup()
          }
        },
      }
    },

    signOut(): void {
      generation++
      const previous = active
      active = undefined
      previous?.()
      try {
        store.remove()
      } catch (error) {
        throw storageError(error, 'remove', 'Could not remove GitHub credential')
      }
    },
  }
}
