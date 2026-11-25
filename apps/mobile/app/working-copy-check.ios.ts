import { File } from '@nativescript/core'
import { createWorkingCopy, prepareWorkingCopyTree } from './working-copy'
import { nativeFiles } from './native-files.ios'
import { nativeWorkingCopy } from './native-working-copy.ios'

/** Exercise the public status interface against a managed clone supplied by the native fixture. */
export async function runWorkingCopyCheck(root: string, remote: string, branch: string) {
  try {
    const status = await createWorkingCopy(nativeWorkingCopy, { root, remote, branch }).status()
    return { root, changes: status.changes, refused: false, refusal: null }
  } catch (error) {
    return {
      root,
      changes: null,
      refused: true,
      refusal: error instanceof Error ? error.message : String(error),
    }
  }
}

export type TreeFixtureMutation = { kind: 'ignore' | 'inventory' | 'head'; head?: string }

/** Exercise real preparation; synthetic races model edits outside the storage queue. */
export async function runWorkingCopyTreeCheck(
  root: string,
  remote: string,
  branch: string,
  mutation?: TreeFixtureMutation,
) {
  const injected: Record<string, string> = {}
  let ordinal = 0
  const adapter = mutation
    ? {
        ...nativeWorkingCopy,
        async prepareWorkingCopyTree(
          canonical: string,
          owner: string,
          attached: string,
          policy: (path: string) => number,
        ) {
          return nativeWorkingCopy.prepareWorkingCopyTree(canonical, owner, attached, (path) => {
            const decision = policy(path)
            if (path === 'note.md') {
              let relative: string
              let bytes: string
              if (mutation.kind === 'head') {
                if (!/^[0-9a-f]{40}$/.test(mutation.head ?? ''))
                  throw new Error('Invalid synthetic head')
                relative = '.git/refs/heads/fixture-start'
                bytes = `${mutation.head}\n`
              } else if (mutation.kind === 'ignore') {
                relative = '.gitignore'
                bytes = 'ignored-*\n# concurrent synthetic edit\n'
              } else {
                relative = `race-created-${++ordinal}.bin`
                bytes = 'concurrent synthetic file\n'
              }
              File.fromPath(`${canonical}/${relative}`).writeTextSync(bytes, (error) => {
                if (error) throw error
              })
              injected[relative] = bytes
            }
            return decision
          })
        },
      }
    : nativeWorkingCopy
  try {
    const tree = await prepareWorkingCopyTree(nativeFiles, adapter, { root, remote, branch })
    return { root, tree, refused: false, refusal: null, injected }
  } catch (error) {
    return {
      root,
      tree: null,
      refused: true,
      refusal: error instanceof Error ? error.message : String(error),
      injected,
    }
  }
}
