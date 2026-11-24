import { withVaultOperation } from './operation-gate'
import { nativeFiles } from './native-files.ios'

class NativeGitError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly gitErrorClass: number,
  ) {
    super(message)
    this.name = 'NativeGitError'
  }
}

export interface NativeGitResult {
  operation: string
  credentialChallenge: boolean
  success: boolean
  branch: string
  fetchTarget: string
  headTarget: string
  hooksDisabled: boolean
  filtersDisabled: boolean
  helpersDisabled: boolean
  remoteConstrained: boolean
}

function checked<T>(operation: (error: interop.Reference<NSError>) => T): T {
  const error = new interop.Reference<NSError>()
  const value = operation(error)
  if (error.value) {
    const code = Number(error.value.code)
    const gitErrorClass = Number(error.value.userInfo.objectForKey('gitErrorClass') ?? -1)
    throw new NativeGitError(error.value.localizedDescription, code, gitErrorClass)
  }
  return value
}

/** Narrow iOS adapter; intentionally does not expose status, commit or merge operations. */
export const nativeGit = {
  version(): string {
    return HoliNativeGit.alloc().init().embeddedVersion()
  },
  async run(
    operation: 'clone' | 'fetch' | 'push' | 'poison',
    root: string,
    remote: string,
    username: string,
    password: string,
  ): Promise<NativeGitResult> {
    if (
      root.length > 4096 ||
      remote.length > 4096 ||
      username.length > 256 ||
      password.length > 1024
    )
      throw new Error('Native Git input exceeds the compatibility-test bound')
    const invoke = (operationRoot: string) => {
      const result = checked((error) =>
        HoliNativeGit.alloc()
          .init()
          .runOperationRootRemoteUsernamePasswordError(
            operation,
            operationRoot,
            remote,
            username,
            password,
            error,
          ),
      )
      if (!result) throw new Error('Native Git returned no operation result')
      return {
        operation: String(result.objectForKey('operation')),
        credentialChallenge: Boolean(result.objectForKey('credentialChallenge')),
        success: Boolean(result.objectForKey('success')),
        branch: String(result.objectForKey('branch')),
        fetchTarget: String(result.objectForKey('fetchTarget')),
        headTarget: String(result.objectForKey('headTarget')),
        hooksDisabled: Boolean(result.objectForKey('hooksDisabled')),
        filtersDisabled: Boolean(result.objectForKey('filtersDisabled')),
        helpersDisabled: Boolean(result.objectForKey('helpersDisabled')),
        remoteConstrained: Boolean(result.objectForKey('remoteConstrained')),
      }
    }
    if (operation === 'clone') return invoke(root)
    return withVaultOperation(nativeFiles, root, (canonicalRoot) =>
      Promise.resolve(invoke(canonicalRoot)),
    )
  },
}
