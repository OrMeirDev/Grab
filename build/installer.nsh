!macro customUnInstall
  ; Keep the stable extension directory during app updates. A full uninstall removes only
  ; Grab's native-host registrations and integration files, never settings/history/downloads.
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.grab.downloader.browser"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.grab.downloader.browser"
    DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.grab.downloader.browser"
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM GrabBrowserHost.exe /T /F'
    Pop $0
    RMDir /r "$LOCALAPPDATA\Grab\browser-integration"
  ${endIf}
!macroend
