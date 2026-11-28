import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

// Opening a FIFO must not block before fstat can reject it.
const evidenceOpenFlags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW

export async function readBoundedJson(path, maxBytes = 262_144) {
  const handle = await open(path, evidenceOpenFlags)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes)
      throw new Error('Invalid or oversized evidence JSON')
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw new Error('Evidence JSON was truncated')
      offset += bytesRead
    }
    return JSON.parse(bytes.toString('utf8'))
  } finally {
    await handle.close()
  }
}

/** Snapshot only caller-owned roots, never following links; record every bounded omission. */
export async function captureStorageEvidence(
  roots,
  output,
  { maxFiles = 128, maxBytes = 2_097_152 } = {},
) {
  const evidence = { files: [], omissions: [] }
  let bytes = 0
  let entries = 0
  for (const root of roots) {
    let canonical
    try {
      if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink())
        throw new Error('Root is not a real directory')
      canonical = await realpath(root)
    } catch (error) {
      evidence.omissions.push({ root, error: String(error) })
      continue
    }
    const walk = async (path, depth) => {
      if (++entries > 512 || depth > 16) {
        evidence.omissions.push({ path, reason: 'entry/depth limit' })
        return
      }
      const rel = relative(canonical, path)
      if (rel === '..' || rel.startsWith(`..${sep}`))
        throw new Error('Evidence path escaped its owned root')
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        evidence.omissions.push({ path, reason: 'symlink' })
        return
      }
      if (info.isDirectory()) {
        if ((await realpath(path)) !== path) throw new Error('Evidence directory alias')
        for (const name of (await readdir(path)).sort()) {
          if (entries >= 512) {
            evidence.omissions.push({ path, reason: 'entry limit' })
            break
          }
          await walk(join(path, name), depth + 1)
        }
      } else if (info.isFile()) {
        if (evidence.files.length >= maxFiles || info.size > maxBytes - bytes) {
          evidence.omissions.push({ path, reason: 'file/byte limit' })
          return
        }
        const handle = await open(path, evidenceOpenFlags)
        try {
          const current = await handle.stat()
          if (
            !current.isFile() ||
            current.size !== info.size ||
            current.ino !== info.ino ||
            current.dev !== info.dev
          )
            throw new Error('Evidence file changed')
          const data = Buffer.alloc(info.size)
          let offset = 0
          while (offset < data.length) {
            const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
            if (!bytesRead) throw new Error('Evidence file was truncated')
            offset += bytesRead
          }
          evidence.files.push({
            root,
            path: rel,
            bytes: data.length,
            base64: data.toString('base64'),
          })
          bytes += data.length
        } finally {
          await handle.close()
        }
      } else evidence.omissions.push({ path, reason: 'non-regular entry' })
    }
    try {
      await walk(canonical, 0)
    } catch (error) {
      evidence.omissions.push({ root, error: String(error) })
    }
  }
  await writeFile(output, JSON.stringify(evidence, null, 2))
  return evidence
}
