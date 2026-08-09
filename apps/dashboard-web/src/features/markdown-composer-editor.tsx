import {
  codeBlockPlugin,
  headingsPlugin,
  linkPlugin,
  listsPlugin,
  MDXEditor,
  type MDXEditorMethods,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
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
  composerCommandSuggestions,
} from './composer-autocomplete';

const COMPOSER_MARKDOWN_PLUGINS = [
  headingsPlugin(),
  listsPlugin(),
  quotePlugin(),
  thematicBreakPlugin(),
  linkPlugin(),
  tablePlugin(),
  codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
  markdownShortcutPlugin(),
];

type MarkdownComposerEditorProps = {
  commands?: readonly ComposerCommandOption[];
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

const MarkdownComposerEditor = forwardRef<
  MDXEditorMethods,
  MarkdownComposerEditorProps
>(function MarkdownComposerEditor(
  { commands = [], initialMarkdown = '', onChange, placeholder, readOnly },
  forwardedRef,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MDXEditorMethods | null>(null);
  const listId = useId();
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedMarkdown, setDismissedMarkdown] = useState<string>();
  const suggestions = useMemo(
    () =>
      dismissedMarkdown === markdown
        ? []
        : composerCommandSuggestions(commands, markdown),
    [commands, dismissedMarkdown, markdown],
  );
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
  const updateMarkdown = useCallback(
    (next: string) => {
      setMarkdown(next);
      setSelectedIndex(0);
      setDismissedMarkdown(undefined);
      onChange(next);
    },
    [onChange],
  );
  const selectCommand = useCallback(
    (command: ComposerCommandOption) => {
      const next = `/${command.name} `;
      editorRef.current?.setMarkdown(next);
      updateMarkdown(next);
      requestAnimationFrame(() => {
        hostRef.current
          ?.querySelector<HTMLElement>('[contenteditable="true"]')
          ?.focus();
      });
    },
    [updateMarkdown],
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
          selectCommand(suggestions[boundedIndex]);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setDismissedMarkdown(markdown);
        }
      }}
    >
      <MDXEditor
        ref={setEditorRef}
        className="composer-rich-editor-root dark-theme"
        contentEditableClassName="composer-rich-editor"
        markdown={initialMarkdown}
        onChange={(next, initialMarkdownNormalize) => {
          if (!initialMarkdownNormalize) updateMarkdown(next);
        }}
        placeholder={placeholder}
        readOnly={readOnly}
        plugins={COMPOSER_MARKDOWN_PLUGINS}
      />
      <ComposerAutocomplete
        id={listId}
        commands={dismissedMarkdown === markdown ? [] : commands}
        markdown={markdown}
        selectedIndex={boundedIndex}
        onSelectedIndexChange={setSelectedIndex}
        onSelect={selectCommand}
      />
    </div>
  );
});

export default MarkdownComposerEditor;
