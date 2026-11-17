import { vaultAssetUrl } from '@/lib/vault-asset'

/** Resolve a document-relative media URL without changing remote or vault URLs. */
export function portableImageSrc(src: string, sourceFolder: string, targetFolder: string): string {
  if (/^(https?:|data:|holi-vault:)/.test(src) || src.startsWith('//') || src.includes('\\\\'))
    return src
  const resolve = (folder: string, value: string) => {
    const parts = (value.startsWith('/') ? value.slice(1) : `${folder}/${value}`).split('/')
    const result: string[] = []
    for (const part of parts) {
      if (!part || part === '.') continue
      if (part === '..') {
        if (!result.length) return null
        result.pop()
      } else {
        try {
          result.push(decodeURIComponent(part))
        } catch {
          return null
        }
      }
    }
    return result
  }
  const absolute = resolve(sourceFolder, src)
  const target = resolve('', targetFolder)
  if (!absolute || !target) return src
  const directory = target
  let common = 0
  while (
    common < directory.length &&
    common < absolute.length &&
    directory[common] === absolute[common]
  )
    common++
  return [...directory.slice(common).map(() => '..'), ...absolute.slice(common)]
    .map((part) => (part === '..' ? part : encodeURIComponent(part)))
    .join('/')
}

export function displaySrc(src: string, folder: string): string {
  if (/^(https?:|data:|holi-vault:)/.test(src)) return src
  const parts = (src.startsWith('/') ? src.slice(1) : `${folder}/${src}`)
    .split('/')
    .filter((part) => part !== '' && part !== '.')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') resolved.pop()
    else resolved.push(decodeURIComponent(part))
  }
  return vaultAssetUrl(resolved.join('/'))
}
