import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export function ownedFixtureDirectory(root: string, child: string): string {
  const base = lstatSync(root)
  if (
    !base.isDirectory() ||
    base.isSymbolicLink() ||
    base.uid !== process.getuid?.() ||
    realpathSync(root) !== root
  )
    throw new Error('Fixture root must be a canonical directory owned by this user')
  const target = resolve(root, child)
  const path = relative(root, target)
  if (isAbsolute(child) || path === '..' || path.startsWith(`..${sep}`))
    throw new Error('Fixture directory escapes its root')
  let current = root
  for (const part of path.split(sep).filter(Boolean)) {
    current = resolve(current, part)
    let info
    try {
      info = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(current, { mode: 0o700 })
      info = lstatSync(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.())
      throw new Error('Fixture directory is linked or not owned by this user')
  }
  return target
}
