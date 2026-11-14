import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const INSTALLER = fileURLToPath(new URL('../build/installer.nsh', import.meta.url))

describe('Windows protocol registration cleanup', () => {
  it('removes the holi scheme only when it belongs to this installation', async () => {
    const installer = await readFile(INSTALLER, 'utf8')
    const uninstall = installer.match(/!macro customUnInstall([\s\S]*?)!macroend/)?.[1]

    expect(uninstall).toBeDefined()
    expect(uninstall).toContain('${ifNot} ${isUpdated}')
    expect(uninstall).toContain(
      'ReadRegStr $R1 HKCU "Software\\Classes\\holi\\shell\\open\\command" ""',
    )
    expect(uninstall).toMatch(/StrCpy \$R0 \$R1 1\s+StrCmp \$R0 '\"' 0 holiUninstallKeepProtocol/)
    expect(uninstall).toContain(
      'IntCmp $R3 $R2 holiUninstallKeepProtocol holiUninstallReadProtocolQuote holiUninstallKeepProtocol',
    )
    expect(uninstall).toMatch(/IntOp \$R3 \$R3 - 1\s+StrCpy \$R4 \$R1 \$R3 1/)
    expect(uninstall).toContain('GetFullPathName $R4 "$R4"')
    expect(uninstall).toContain('GetFullPathName $R5 "$INSTDIR\\${PRODUCT_FILENAME}.exe"')
    expect(uninstall).toContain('StrCmp $R4 $R5 0 holiUninstallKeepProtocol')
    expect(uninstall).toMatch(
      /StrCmp \$R4 \$R5 0 holiUninstallKeepProtocol[\s\S]*?DeleteRegKey HKCU "Software\\Classes\\holi"/,
    )
  })
})
