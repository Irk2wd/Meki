; Register the research edition as a separate Markdown handler.
!macro mekiExtension EXT
  WriteRegStr SHCTX "Software\Classes\${EXT}\OpenWithProgids" "mekiR.Markdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\mekiR.exe\SupportedTypes" "${EXT}" ""
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\mekiR.Markdown" "" "Markdown document"
  WriteRegStr SHCTX "Software\Classes\mekiR.Markdown\DefaultIcon" "" '"$INSTDIR\mekiR.exe",0'
  WriteRegStr SHCTX "Software\Classes\mekiR.Markdown\shell\open\command" "" '"$INSTDIR\mekiR.exe" --open "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\mekiR.exe" "FriendlyAppName" "mekiR"
  WriteRegStr SHCTX "Software\Classes\Applications\mekiR.exe\shell\open\command" "" '"$INSTDIR\mekiR.exe" --open "%1"'
  !insertmacro mekiExtension ".md"
  !insertmacro mekiExtension ".markdown"
  !insertmacro mekiExtension ".mdown"
  !insertmacro mekiExtension ".mkd"
  !insertmacro mekiExtension ".mkdn"
  !insertmacro mekiExtension ".txt"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "mekiR.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "mekiR.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.mdown\OpenWithProgids" "mekiR.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.mkd\OpenWithProgids" "mekiR.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.mkdn\OpenWithProgids" "mekiR.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.txt\OpenWithProgids" "mekiR.Markdown"
  DeleteRegKey SHCTX "Software\Classes\mekiR.Markdown"
  DeleteRegKey SHCTX "Software\Classes\Applications\mekiR.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
