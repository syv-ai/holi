/**
 * A vault-relative path → a `holi-vault://` URL for `<img src>`. Each segment is
 * percent-encoded (spaces, `#`, …) but the `/` separators are preserved. The
 * host is a fixed `vault`; the main-process handler resolves it against the
 * active vault (see main/vault/asset-protocol.ts).
 */
export function vaultAssetUrl(vaultRelPath: string): string {
  const encoded = vaultRelPath.split('/').map(encodeURIComponent).join('/')
  return `holi-vault://vault/${encoded}`
}
