import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
} from '@codemirror/commands';
import {
  markdownLanguage,
  markdown as markdownLanguageExtension,
} from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  placeholder as editorPlaceholder,
  keymap,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { dashboardHttpClient } from '@pi-dashboard/client';
import type { ComposerFileSuggestion } from '@pi-dashboard/protocol';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ComposerAutocomplete,
  type ComposerCommandOption,
  type ComposerCompletionToken,
  type ComposerSuggestion,
  composerCommandSuggestions,
  composerCompletionToken,
  composerFileSuggestionOptions,
} from './composer-autocomplete';

type CompletionAnchor = ComposerCompletionToken & { from: number; to: number };

type MarkdownComposerEditorProps = {
  commands?: readonly ComposerCommandOption[];
  cwd?: string;
  markdown: string;
  onChange: (markdown: string) => void;
  placeholder: string;
  readOnly: boolean;
};

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-heading1' },
  { tag: tags.heading2, class: 'cm-heading2' },
  { tag: tags.heading3, class: 'cm-heading3' },
  { tag: tags.heading4, class: 'cm-heading4' },
  { tag: tags.heading5, class: 'cm-heading5' },
  { tag: tags.heading6, class: 'cm-heading6' },
  { tag: tags.emphasis, class: 'cm-emphasis' },
  { tag: tags.strong, class: 'cm-strong' },
  { tag: tags.link, class: 'cm-link' },
  { tag: tags.url, class: 'cm-url' },
  { tag: tags.monospace, class: 'cm-monospace' },
  { tag: tags.processingInstruction, class: 'cm-markup' },
  { tag: tags.meta, class: 'cm-markup' },
  { tag: tags.keyword, color: 'var(--purple)' },
  { tag: tags.string, color: 'var(--green)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--purple)' },
  {
    tag: [tags.function(tags.variableName), tags.tagName],
    color: 'var(--cyan)',
  },
]);

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-scroller': {
    maxHeight: '180px',
    overflow: 'auto',
    fontFamily: 'inherit',
  },
  '.cm-placeholder': { color: 'var(--muted)' },
  '.cm-content': {
    maxHeight: '180px',
    overflowY: 'auto',
    padding: '10px 8px 8px',
    caretColor: 'var(--fg)',
  },
  '.cm-line': { lineHeight: '1.55' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--selection, #ffffff2b)',
  },
});

function anchorKey(anchor: CompletionAnchor | undefined): string | undefined {
  return anchor ? `${anchor.from}:${anchor.to}:${anchor.prefix}` : undefined;
}

function completionAnchor(state: EditorState): CompletionAnchor | undefined {
  if (!state.selection.main.empty) return undefined;
  const cursor = state.selection.main.head;
  const line = state.doc.lineAt(cursor);
  const token = composerCompletionToken(line.text, cursor - line.from);
  return token
    ? {
        ...token,
        from: line.from + token.start,
        to: line.from + token.end,
      }
    : undefined;
}

export default function MarkdownComposerEditor({
  commands = [],
  cwd,
  markdown,
  onChange,
  placeholder,
  readOnly,
}: MarkdownComposerEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const anchorRef = useRef<CompletionAnchor | undefined>(undefined);
  const markdownRef = useRef(markdown);
  const readOnlyCompartment = useMemo(() => new Compartment(), []);
  const placeholderCompartment = useMemo(() => new Compartment(), []);
  const listId = useId();
  const [anchor, setAnchor] = useState<CompletionAnchor>();
  const [files, setFiles] = useState<readonly ComposerFileSuggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string>();

  onChangeRef.current = onChange;
  markdownRef.current = markdown;

  const commandSuggestions = useMemo(
    () => composerCommandSuggestions(commands, anchor),
    [anchor, commands],
  );
  const fileSuggestions = useMemo(
    () => composerFileSuggestionOptions(files, anchor),
    [anchor, files],
  );
  const suggestions =
    dismissedKey === anchorKey(anchor)
      ? []
      : anchor?.kind === 'file'
        ? fileSuggestions
        : commandSuggestions;
  const boundedIndex = suggestions.length
    ? Math.min(selectedIndex, suggestions.length - 1)
    : 0;

  const publishAnchor = useCallback((next: CompletionAnchor | undefined) => {
    if (anchorKey(anchorRef.current) === anchorKey(next)) return;
    anchorRef.current = next;
    setAnchor(next);
    setSelectedIndex(0);
    setDismissedKey(undefined);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: markdownRef.current,
        extensions: [
          markdownLanguageExtension({
            base: markdownLanguage,
            codeLanguages: languages,
            completeHTMLTags: false,
            pasteURLAsLink: false,
          }),
          syntaxHighlighting(markdownHighlightStyle),
          editorTheme,
          placeholderCompartment.of(editorPlaceholder('')),
          EditorView.lineWrapping,
          EditorView.editorAttributes.of({
            class: 'composer-rich-editor-root',
          }),
          EditorView.contentAttributes.of({
            class: 'composer-rich-editor',
            'aria-label': 'Message Pi',
            'aria-autocomplete': 'list',
            'aria-multiline': 'true',
            role: 'textbox',
            spellcheck: 'false',
          }),
          readOnlyCompartment.of([
            EditorState.readOnly.of(false),
            EditorView.editable.of(true),
          ]),
          history(),
          keymap.of([...historyKeymap, ...defaultKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const next = update.state.doc.toString();
              if (next !== markdownRef.current) {
                markdownRef.current = next;
                onChangeRef.current(next);
              }
            }
            if (update.selectionSet || update.docChanged)
              publishAnchor(completionAnchor(update.state));
          }),
        ],
      }),
    });
    viewRef.current = view;
    publishAnchor(completionAnchor(view.state));
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [placeholderCompartment, publishAnchor, readOnlyCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: placeholderCompartment.reconfigure(
        editorPlaceholder(placeholder),
      ),
    });
  }, [placeholder, placeholderCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== markdown) {
      markdownRef.current = markdown;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: markdown },
        selection: {
          anchor: Math.min(view.state.selection.main.head, markdown.length),
        },
      });
    }
  }, [markdown]);

  useEffect(() => {
    const view = viewRef.current;
    if (view)
      view.dispatch({
        effects: readOnlyCompartment.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      });
  }, [readOnly, readOnlyCompartment]);

  useEffect(() => {
    const content = hostRef.current?.querySelector<HTMLElement>('.cm-content');
    if (!content) return;
    content.setAttribute('aria-expanded', String(suggestions.length > 0));
    if (suggestions.length > 0) {
      content.setAttribute('aria-controls', listId);
      content.setAttribute(
        'aria-activedescendant',
        `${listId}-option-${boundedIndex}`,
      );
    } else {
      content.removeAttribute('aria-controls');
      content.removeAttribute('aria-activedescendant');
    }
  }, [boundedIndex, listId, suggestions.length]);

  useEffect(() => {
    if (!cwd || anchor?.kind !== 'file') {
      setFiles([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void dashboardHttpClient
        .composerFileSuggestions(cwd, anchor.query, controller.signal)
        .then((result) => setFiles(result.suggestions))
        .catch(() => {
          if (!controller.signal.aborted) setFiles([]);
        });
    }, 100);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [anchor?.kind, anchor?.query, cwd]);

  const selectSuggestion = useCallback((suggestion: ComposerSuggestion) => {
    const view = viewRef.current;
    const currentAnchor = anchorRef.current;
    if (!view || !currentAnchor) return;
    view.dispatch({
      changes: {
        from: currentAnchor.from,
        to: currentAnchor.to,
        insert: suggestion.value,
      },
      selection: {
        anchor: currentAnchor.from + suggestion.value.length,
      },
      userEvent: 'input.complete',
      annotations: isolateHistory.of('full'),
    });
    setDismissedKey(
      `${currentAnchor.from}:${currentAnchor.from + suggestion.value.length}:${suggestion.value}`,
    );
    requestAnimationFrame(() => view.focus());
  }, []);

  return (
    <div
      className="composer-editor-mount"
      onKeyDownCapture={(event) => {
        if (!suggestions.length) return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          event.stopPropagation();
          setSelectedIndex((current) => (current + 1) % suggestions.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          event.stopPropagation();
          setSelectedIndex(
            (current) =>
              (current - 1 + suggestions.length) % suggestions.length,
          );
          return;
        }
        if (
          (event.key === 'Enter' || event.key === 'Tab') &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          selectSuggestion(suggestions[boundedIndex]);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setDismissedKey(anchorKey(anchor));
        }
      }}
    >
      <div ref={hostRef} />
      <ComposerAutocomplete
        id={listId}
        suggestions={suggestions}
        selectedIndex={boundedIndex}
        onSelectedIndexChange={setSelectedIndex}
        onSelect={selectSuggestion}
      />
    </div>
  );
}
