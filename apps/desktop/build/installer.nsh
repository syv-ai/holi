; electron-builder names a per-user one-click install folder after package.json's
; name, "@holi/desktop", which gives "...\Programs\@holidesktop". Name it Holi
; instead on a first install. An existing install keeps its recorded folder, so
; an update lands where Holi already is, and /D=<dir> still wins. A redirected
; per-user programs folder (policy, roaming profile) is not looked up: that is
; more NSIS than a folder name is worth.
!macro customInit
  ; GetDParameter saves and restores $R5-$R9 itself, so its result goes in $R0.
  ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  !insertmacro GetDParameter $R0
  ${If} $R1 == ""
  ${AndIf} $R0 == ""
    StrCpy $INSTDIR "$LocalAppData\Programs\${PRODUCT_FILENAME}"
  ${EndIf}
!macroend

; The running app registers the holi:// scheme itself (setAsDefaultProtocolClient),
; which the uninstaller does not know to undo; left behind it points at a
; deleted Holi.exe. Only remove a registration that points at this installation:
; another Holi install may have registered itself later. An update runs the old
; uninstaller too, so skip it then.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadRegStr $R1 HKCU "Software\Classes\holi\shell\open\command" ""
    ; Electron registers a quoted executable followed by quoted arguments. Find
    ; the matching closing quote rather than splitting on spaces in the path.
    StrCpy $R0 $R1 1
    StrCmp $R0 '"' 0 holiUninstallKeepProtocol
    StrLen $R2 $R1
    IntOp $R2 $R2 - 1
    StrCpy $R3 1
    holiUninstallFindProtocolQuote:
      IntCmp $R3 $R2 holiUninstallKeepProtocol holiUninstallReadProtocolQuote holiUninstallKeepProtocol
    holiUninstallReadProtocolQuote:
      StrCpy $R0 $R1 1 $R3
      StrCmp $R0 '"' holiUninstallCompareProtocol
      IntOp $R3 $R3 + 1
      Goto holiUninstallFindProtocolQuote
    holiUninstallCompareProtocol:
      IntOp $R3 $R3 - 1
      StrCpy $R4 $R1 $R3 1
      GetFullPathName $R4 "$R4"
      GetFullPathName $R5 "$INSTDIR\${PRODUCT_FILENAME}.exe"
      ; StrCmp is case-insensitive on Windows; GetFullPathName normalizes both
      ; paths before comparison, while the quotes above protect spaces.
      StrCmp $R4 $R5 0 holiUninstallKeepProtocol
      DeleteRegKey HKCU "Software\Classes\holi"
    holiUninstallKeepProtocol:
  ${endIf}
!macroend
