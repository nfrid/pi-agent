import {
  type ComponentProps,
  isValidElement,
  memo,
  type ReactNode,
  useState,
} from 'react';
import MarkdownRenderer from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './entities/transcript/markdown.module.css';

const remarkPlugins = [remarkGfm];

export async function copyText(text: string) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function textContent(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (isValidElement<{ children?: ReactNode }>(value)) {
    return textContent(value.props.children);
  }
  return '';
}

function CodeBlock({
  node: _node,
  children,
  ...props
}: ComponentProps<'pre'> & { node?: unknown }) {
  const [copied, setCopied] = useState(false);
  const label = copied ? 'Copied code block' : 'Copy code block';
  return (
    <pre {...props} className={styles.codeBlock}>
      {children}
      <button
        type="button"
        className={`assistant-message-copy ${styles.codeBlockCopy}`}
        aria-label={label}
        title={label}
        onClick={async () => {
          try {
            await copyText(textContent(children).replace(/\n$/, ''));
            setCopied(true);
          } catch {
            // Clipboard permission can be denied without affecting the transcript.
          }
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16">
          {copied ? (
            <path d="m3 8 3 3 7-7" />
          ) : (
            <>
              <rect x="5" y="5" width="8" height="8" rx="1" />
              <path d="M3 11H2V3a1 1 0 0 1 1-1h8v1" />
            </>
          )}
        </svg>
      </button>
    </pre>
  );
}

const markdownComponents = {
  a: ({ node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) => (
    <a {...props} target="_blank" rel="noreferrer noopener" />
  ),
  pre: CodeBlock,
};

export const Markdown = memo(function Markdown({
  children,
}: {
  children: string;
}) {
  return (
    <div className={`markdown ${styles.markdown}`}>
      <MarkdownRenderer
        remarkPlugins={remarkPlugins}
        components={markdownComponents}
      >
        {children}
      </MarkdownRenderer>
    </div>
  );
});
