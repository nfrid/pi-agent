import {
  codeBlockPlugin,
  headingsPlugin,
  linkPlugin,
  listsPlugin,
  MDXEditor,
  type MDXEditorMethods,
  markdownShortcutPlugin,
  quotePlugin,
  realmPlugin,
  rootEditor$,
  tablePlugin,
  thematicBreakPlugin,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { dashboardHttpClient } from '@pi-dashboard/client';
import type { ComposerFileSuggestion } from '@pi-dashboard/protocol';
import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type LexicalEditor,
} from 'lexical';
import {
  type ForwardedRef,
  forwardRef,
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

const editorBridgePlugin = realmPlugin<{
  onEditor: (editor: LexicalEditor) => void;
}>({
  postInit(realm, params) {
    const editor = realm.getValue(rootEditor$);
    if (editor && params) params.onEditor(editor);
  },
});

type CompletionAnchor = ComposerCompletionToken & { nodeKey: string };

type MarkdownComposerEditorProps = {
  commands?: readonly ComposerCommandOption[];
  cwd?: string;
  initialMarkdown?: string;
  onChange: (markdown: string) => void;
  placeholder: string;
  readOnly: boolean;
};

function assignEditorRef(
  ref: ForwardedRef<MDXEditorMethods>,
  value: MDXEditorMethods | null,
): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

function completionAnchor(editor: LexicalEditor): CompletionAnchor | undefined {
  return editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (
      !$isRangeSelection(selection) ||
      !selection.isCollapsed() ||
      selection.anchor.type !== 'text'
    )
      return undefined;
    const node = selection.anchor.getNode();
    if (!$isTextNode(node)) return undefined;
    const token = composerCompletionToken(
      node.getTextContent(),
      selection.anchor.offset,
    );
    return token ? { ...token, nodeKey: node.getKey() } : undefined;
  });
}

function anchorKey(anchor: CompletionAnchor | undefined): string | undefined {
  return anchor
    ? `${anchor.nodeKey}:${anchor.start}:${anchor.end}:${anchor.prefix}`
    : undefined;
}

const MarkdownComposerEditor = forwardRef<
  MDXEditorMethods,
  MarkdownComposerEditorProps
>(function MarkdownComposerEditor(
  { commands = [], cwd, initialMarkdown = '', onChange, placeholder, readOnly },
  forwardedRef,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const lexicalEditorRef = useRef<LexicalEditor | null>(null);
  const listenerCleanupRef = useRef<() => void>(() => undefined);
  const anchorRef = useRef<CompletionAnchor | undefined>(undefined);
  const listId = useId();
  const [anchor, setAnchor] = useState<CompletionAnchor>();
  const [files, setFiles] = useState<readonly ComposerFileSuggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string>();
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
  const setEditorRef = useCallback(
    (value: MDXEditorMethods | null) => {
      editorRef.current = value;
      assignEditorRef(forwardedRef, value);
    },
    [forwardedRef],
  );
  const connectLexicalEditor = useCallback((editor: LexicalEditor) => {
    listenerCleanupRef.current();
    lexicalEditorRef.current = editor;
    const publishAnchor = () => {
      const next = completionAnchor(editor);
      if (anchorKey(anchorRef.current) === anchorKey(next)) return;
      anchorRef.current = next;
      setAnchor(next);
      setSelectedIndex(0);
      setDismissedKey(undefined);
    };
    publishAnchor();
    listenerCleanupRef.current = editor.registerUpdateListener(publishAnchor);
  }, []);
  const bridge = useMemo(
    () => editorBridgePlugin({ onEditor: connectLexicalEditor }),
    [connectLexicalEditor],
  );
  const plugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin(),
      tablePlugin(),
      codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
      markdownShortcutPlugin(),
      bridge,
    ],
    [bridge],
  );

  useEffect(() => () => listenerCleanupRef.current(), []);

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

  const selectSuggestion = useCallback(
    (suggestion: ComposerSuggestion) => {
      const editor = lexicalEditorRef.current;
      if (!editor || !anchor) return;
      editor.update(() => {
        const node = $getNodeByKey(anchor.nodeKey);
        if (!$isTextNode(node)) return;
        node.select(anchor.start, anchor.end);
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const replacement =
          suggestion.kind === 'command'
            ? `${suggestion.value} `
            : suggestion.value;
        selection.insertText(replacement);
      });
      setDismissedKey(
        `${anchor.nodeKey}:${anchor.start}:${anchor.start + suggestion.value.length}:${suggestion.value}`,
      );
      requestAnimationFrame(() => editor.focus());
    },
    [anchor],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const labelEditor = () => {
      const editable = host.querySelector<HTMLElement>(
        '[contenteditable="true"]',
      );
      if (!editable) return;
      editable.setAttribute('aria-label', 'Message Pi');
      editable.setAttribute('role', 'textbox');
      editable.setAttribute('aria-multiline', 'true');
      editable.setAttribute('aria-autocomplete', 'list');
      editable.setAttribute('aria-expanded', String(suggestions.length > 0));
      if (suggestions.length > 0) {
        editable.setAttribute('aria-controls', listId);
        editable.setAttribute(
          'aria-activedescendant',
          `${listId}-option-${boundedIndex}`,
        );
      } else {
        editable.removeAttribute('aria-controls');
        editable.removeAttribute('aria-activedescendant');
      }
    };
    labelEditor();
    const observer = new MutationObserver(labelEditor);
    observer.observe(host, {
      attributes: true,
      attributeFilter: ['contenteditable'],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [boundedIndex, listId, suggestions.length]);

  return (
    <div
      className="composer-editor-mount"
      ref={hostRef}
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
      <MDXEditor
        ref={setEditorRef}
        className="composer-rich-editor-root dark-theme"
        contentEditableClassName="composer-rich-editor"
        markdown={initialMarkdown}
        onChange={(next: string, initialMarkdownNormalize: boolean) => {
          if (!initialMarkdownNormalize) onChange(next);
        }}
        placeholder={placeholder}
        readOnly={readOnly}
        plugins={plugins}
      />
      <ComposerAutocomplete
        id={listId}
        suggestions={suggestions}
        selectedIndex={boundedIndex}
        onSelectedIndexChange={setSelectedIndex}
        onSelect={selectSuggestion}
      />
    </div>
  );
});

export default MarkdownComposerEditor;
