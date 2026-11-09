import { vaultAssetUrl } from '@/lib/vault-asset'

/** Resolve a document-relative media URL without changing remote or vault URLs. */
export function displaySrc(src: string, folder: string): string {
  if (/^(https?:|data:|holi-vault:)/.test(src)) return src
  const parts = (src.startsWith('/') ? src.slice(1) : `${folder}/${src}`)
    .split('/')
    .filter((part) => part !== '' && part !== '.')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') resolved.pop()
    else resolved.push(decodeURI(part))
  }
  return vaultAssetUrl(resolved.join('/'))
}
