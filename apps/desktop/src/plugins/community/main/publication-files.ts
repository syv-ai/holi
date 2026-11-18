import { lstat, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { readBoundedRegularText } from './fetch'

export async function assertSafePublicationPath(root: string, path: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  if (canonicalRoot !== resolve(root)) throw new Error('vault root is not canonical')
  const rel = relative(canonicalRoot, resolve(path))
  if (rel.startsWith('..') || resolve(path) !== join(canonicalRoot, rel))
    throw new Error('publication path escapes the vault')
  let current = canonicalRoot
  for (const part of rel.split(sep).slice(0, -1)) {
    current = join(current, part)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info?.isSymbolicLink() || (info !== null && !info.isDirectory()))
      throw new Error(`unsafe vault path ancestor: ${current}`)
  }
}

export async function readOptionalPublicationText(
  path: string,
  label: string,
): Promise<string | null> {
  try {
    return await readBoundedRegularText(path, label)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
