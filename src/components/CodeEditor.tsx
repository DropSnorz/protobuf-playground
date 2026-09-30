import { json } from '@codemirror/lang-json';
import { StreamLanguage } from '@codemirror/language';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';

const protoLang = StreamLanguage.define(protobuf);

const theme = EditorView.theme({
  '&': { fontSize: '12.5px', height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-gutters': { background: 'var(--editor-gutter)', border: 'none', color: 'var(--muted-2)' },
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--text)' },
  '.cm-activeLine': { background: 'var(--editor-active)' },
  '.cm-error-line': { background: 'var(--error-line)' },
  '&.cm-focused': { outline: 'none' },
});

function errorLineExt(line: number | undefined) {
  return EditorView.decorations.compute(['doc'], (state): DecorationSet => {
    const b = new RangeSetBuilder<Decoration>();
    if (line && line >= 1 && line <= state.doc.lines) {
      b.add(state.doc.line(line).from, state.doc.line(line).from, Decoration.line({ class: 'cm-error-line' }));
    }
    return b.finish();
  });
}

export function CodeEditor(props: {
  value: string;
  onChange?: (v: string) => void;
  language: 'proto' | 'json';
  readOnly?: boolean;
  errorLine?: number;
  ariaLabel: string;
}) {
  const extensions = useMemo(
    () => [props.language === 'proto' ? protoLang : json(), theme, EditorView.lineWrapping, errorLineExt(props.errorLine)],
    [props.language, props.errorLine],
  );
  return (
    <div className={`editor ${props.readOnly ? 'editor-ro' : ''}`}>
      <CodeMirror
        value={props.value}
        onChange={props.onChange}
        extensions={extensions}
        readOnly={props.readOnly}
        editable={!props.readOnly}
        basicSetup={{ foldGutter: false, highlightActiveLine: !props.readOnly, autocompletion: false, searchKeymap: false }}
        height="100%"
        aria-label={props.ariaLabel}
      />
    </div>
  );
}
