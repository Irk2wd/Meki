import { EditorView } from '@codemirror/view';

/** Draw one selection layer; native CodeMirror selection remains transparent. */
export const editorHighlights = EditorView.theme({
  '.cm-activeLine,.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLineGutter': { color: 'var(--accent)' },
  '.cm-selectionBackground': { backgroundColor: 'var(--editor-selection-inactive) !important', borderRadius: '2px' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--editor-selection) !important' },
});
