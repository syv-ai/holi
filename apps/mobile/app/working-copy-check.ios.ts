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

/** Exercise the public tree-preparation interface on the native managed clone. */
export async function runWorkingCopyTreeCheck(root: string, remote: string, branch: string) {
  try {
    const tree = await prepareWorkingCopyTree(nativeFiles, nativeWorkingCopy, {
      root,
      remote,
      branch,
    })
    return { root, tree, refused: false, refusal: null }
  } catch (error) {
    return {
      root,
      tree: null,
      refused: true,
      refusal: error instanceof Error ? error.message : String(error),
    }
  }
}
