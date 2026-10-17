// CodeMirror 6 SQL editor (optional Vim mode), bundled into src/frontend/editor.js as the global `CM`.
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { MySQL, PostgreSQL, SQLite, sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { undo } from '@codemirror/commands';
import { Vim, getCM, vim } from '@replit/codemirror-vim';

const dialects = { postgres: PostgreSQL, sqlite: SQLite, mysql: MySQL };

// Every colour is a CSS variable from src/frontend/style.css, so the theme switch needs no rebuild of these rules.
// Amber is reserved for actions and selection, so syntax stays cool and muted.
const look = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--ground)', color: 'var(--text)', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent-line)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent-line)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--sel)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-gutters': { backgroundColor: 'var(--ground)', color: 'var(--gutter)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--dim)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--sel)', outline: '1px solid var(--accent-line)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--rule)', borderRadius: '6px', color: 'var(--text)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12.5px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--sel)', color: 'var(--text)' },
  '.cm-completionDetail': { color: 'var(--dim)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--rule)' },
  '.cm-panel input, .cm-panel button': { font: 'inherit' },
});

const syntax = syntaxHighlighting(HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: t.typeName, color: 'var(--syn-type)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation], color: 'var(--dim)' },
]));

window.CM = {
  // onRun fires on Mod-Enter, onChange after every edit (not after setState). dialect: 'postgres' | 'sqlite' | 'mysql';
  // schema: { table: [column, ...] }.
  create({ parent, onRun, onChange = () => {} }) {
    const lang = new Compartment();
    const vimBox = new Compartment();
    const darkBox = new Compartment();  // tells CodeMirror's own base styles whether the page is dark
    Vim.defineEx('write', 'w', () => onRun());  // :w runs the query
    let dialect = 'postgres', schema = {}, vimOn = false, dark = true;
    const sqlExt = () => sql({ dialect: dialects[dialect], schema });
    const vimExt = () => (vimOn ? vim({ status: true }) : []);
    const darkExt = () => EditorView.darkTheme.of(dark);
    // A fresh state for a document, already configured with the current dialect, schema, vim and theme.
    const makeState = (doc = '') => EditorState.create({
      doc,
      extensions: [
        vimBox.of(vimExt()),  // must come before other keymaps, hence first
        // Beats the default keymap, where Mod-Enter inserts a blank line.
        Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (onRun(), true) }])),
        darkBox.of(darkExt()),
        basicSetup, lang.of(sqlExt()), syntax, look,
        EditorView.updateListener.of((u) => { if (u.docChanged) onChange(); }),
      ],
    });
    const view = new EditorView({ parent, state: makeState() });
    const reconfigure = () => view.dispatch({ effects: lang.reconfigure(sqlExt()) });
    return {
      focus: () => view.focus(),
      setTheme: (name) => { dark = name === 'dark'; view.dispatch({ effects: darkBox.reconfigure(darkExt()) }); },
      setVim: (on) => { vimOn = !!on; view.dispatch({ effects: vimBox.reconfigure(vimExt()) }); },
      // Per-tab documents: getState() returns an opaque snapshot (text, undo history, cursor) and setState() puts one back.
      // With no snapshot, `text` opens as a fresh document with an empty undo history. An old snapshot may carry a stale
      // dialect/schema/vim/theme, so those are re-applied right after.
      getState: () => view.state,
      setState: (state, text = '') => {
        view.setState(state || makeState(text));
        view.dispatch({ effects: [lang.reconfigure(sqlExt()), vimBox.reconfigure(vimExt()), darkBox.reconfigure(darkExt())] });
      },
      getValue: () => view.state.doc.toString(),
      setValue: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } }),
      selectedText: () => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
      select: (anchor, head) => view.dispatch({ selection: { anchor, head } }),
      setDialect: (d) => { if (dialects[d] && d !== dialect) { dialect = d; reconfigure(); } },
      setSchema: (s) => { schema = s; reconfigure(); },
      // test hooks
      nodeNames: () => { const out = []; syntaxTree(view.state).iterate({ enter: (n) => { out.push(n.name); } }); return out; },
      async completionLabels() {
        startCompletion(view);
        await new Promise((r) => setTimeout(r, 300));
        return currentCompletions(view.state).map((c) => c.label);
      },
      vimKeys: (keys) => Vim.handleKey(getCM(view), keys, 'user'),
      vimEx: (cmd) => Vim.handleEx(getCM(view), cmd),
      undo: () => undo(view),
      cursorToEnd: () => view.dispatch({ selection: { anchor: view.state.doc.length } }),
    };
  },
};
