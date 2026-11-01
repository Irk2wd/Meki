; Display Meki while retaining the existing OpenWith registration and executable.
!macro mekiExtension EXT
  WriteRegStr SHCTX "Software\Classes\${EXT}\OpenWithProgids" "Meki.Markdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\Meki.exe\SupportedTypes" "${EXT}" ""
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\Meki.Markdown" "" "Markdown document"
  WriteRegStr SHCTX "Software\Classes\Meki.Markdown\DefaultIcon" "" '"$INSTDIR\Meki.exe",0'
  WriteRegStr SHCTX "Software\Classes\Meki.Markdown\shell\open\command" "" '"$INSTDIR\Meki.exe" --open "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\Meki.exe" "FriendlyAppName" "Meki"
  WriteRegStr SHCTX "Software\Classes\Applications\Meki.exe\shell\open\command" "" '"$INSTDIR\Meki.exe" --open "%1"'
  !insertmacro mekiExtension ".md"
  !insertmacro mekiExtension ".markdown"
  !insertmacro mekiExtension ".mdown"
  !insertmacro mekiExtension ".mkd"
  !insertmacro mekiExtension ".mkdn"
  !insertmacro mekiExtension ".txt"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "Meki.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "Meki.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.mdown\OpenWithProgids" "Meki.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.mkd\OpenWithProgids" "Meki.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.mkdn\OpenWithProgids" "Meki.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.txt\OpenWithProgids" "Meki.Markdown"
  DeleteRegKey SHCTX "Software\Classes\Meki.Markdown"
  DeleteRegKey SHCTX "Software\Classes\Applications\Meki.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
