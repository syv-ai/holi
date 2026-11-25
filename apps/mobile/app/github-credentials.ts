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

type Authorization = DeviceAuthorization & { wait(): Promise<void> }

/** Owns the saved GitHub credential and makes in-flight authorizations transactional. */
export function createGitHubCredentials(store: CredentialStore) {
  let generation = 0
  let active: (() => void) | undefined

  return {
    readToken(): string | null {
      try {
        return store.read()
      } catch {
        throw new Error('Could not read GitHub credential')
      }
    },

    async authorize(options: DeviceAuthOptions): Promise<Authorization> {
      const current = ++generation
      active?.()
      const controller = createCancellation()
      const externalSignal = options.signal
      const cleanup = () => {
        externalSignal?.removeEventListener('abort', cancel)
        if (active === cancel) active = undefined
      }
      const cancel = () => {
        controller.abort()
        cleanup()
      }
      active = cancel
      externalSignal?.addEventListener('abort', cancel)
      if (externalSignal?.aborted) controller.abort()
      let session
      try {
        session = await authorizeWithGitHub({ ...options, signal: controller.signal })
      } catch {
        cleanup()
        if (current !== generation || controller.signal.aborted)
          throw new Error('Authorization cancelled')
        throw new Error('GitHub authorization failed')
      }
      if (current !== generation || controller.signal.aborted) {
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
            const token = await session.wait()
            if (current !== generation || controller.signal.aborted)
              throw new Error('Authorization cancelled')
            try {
              store.write(token)
            } catch {
              throw new Error('Could not save GitHub credential')
            }
            return
          } finally {
            cleanup()
          }
        },
      }
    },

    signOut(): void {
      generation++
      active?.()
      active = undefined
      try {
        store.remove()
      } catch {
        throw new Error('Could not remove GitHub credential')
      }
    },
  }
}
