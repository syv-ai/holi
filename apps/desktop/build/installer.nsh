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
; deleted Holi.exe. An update runs the old uninstaller too, so skip it then.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\holi"
  ${endIf}
!macroend
