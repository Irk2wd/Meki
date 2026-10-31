; Display Meki while retaining the existing OpenWith registration and executable.
!macro moyeExtension EXT
  WriteRegStr SHCTX "Software\Classes\${EXT}\OpenWithProgids" "Moye.Markdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\Moye.exe\SupportedTypes" "${EXT}" ""
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\Moye.Markdown" "" "Markdown document"
  WriteRegStr SHCTX "Software\Classes\Moye.Markdown\DefaultIcon" "" '"$INSTDIR\Moye.exe",0'
  WriteRegStr SHCTX "Software\Classes\Moye.Markdown\shell\open\command" "" '"$INSTDIR\Moye.exe" --open "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\Moye.exe" "FriendlyAppName" "Meki"
  WriteRegStr SHCTX "Software\Classes\Applications\Moye.exe\shell\open\command" "" '"$INSTDIR\Moye.exe" --open "%1"'
  !insertmacro moyeExtension ".md"
  !insertmacro moyeExtension ".markdown"
  !insertmacro moyeExtension ".mdown"
  !insertmacro moyeExtension ".mkd"
  !insertmacro moyeExtension ".mkdn"
  !insertmacro moyeExtension ".txt"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "Moye.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "Moye.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.mdown\OpenWithProgids" "Moye.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.mkd\OpenWithProgids" "Moye.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.mkdn\OpenWithProgids" "Moye.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.txt\OpenWithProgids" "Moye.Markdown"
  DeleteRegKey SHCTX "Software\Classes\Moye.Markdown"
  DeleteRegKey SHCTX "Software\Classes\Applications\Moye.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
