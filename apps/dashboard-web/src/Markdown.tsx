import { type ComponentProps, memo } from 'react';
import MarkdownRenderer from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './entities/transcript/markdown.module.css';

const remarkPlugins = [remarkGfm];
const markdownComponents = {
  a: ({ node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) => (
    <a {...props} target="_blank" rel="noreferrer noopener" />
  ),
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
