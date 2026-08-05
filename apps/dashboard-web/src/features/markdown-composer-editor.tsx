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
import { forwardRef, useEffect, useRef } from 'react';

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
  onChange: (markdown: string) => void;
  placeholder: string;
  readOnly: boolean;
};

const MarkdownComposerEditor = forwardRef<
  MDXEditorMethods,
  MarkdownComposerEditorProps
>(function MarkdownComposerEditor({ onChange, placeholder, readOnly }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
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
  }, []);
  return (
    <div className="composer-editor-mount" ref={hostRef}>
      <MDXEditor
        ref={ref}
        className="composer-rich-editor-root dark-theme"
        contentEditableClassName="composer-rich-editor"
        markdown=""
        onChange={(markdown, initialMarkdownNormalize) => {
          if (!initialMarkdownNormalize) onChange(markdown);
        }}
        placeholder={placeholder}
        readOnly={readOnly}
        plugins={COMPOSER_MARKDOWN_PLUGINS}
      />
    </div>
  );
});

export default MarkdownComposerEditor;
