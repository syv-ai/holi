import { createWorkingCopy } from './working-copy'
import { nativeWorkingCopy } from './working-copy.ios'

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
