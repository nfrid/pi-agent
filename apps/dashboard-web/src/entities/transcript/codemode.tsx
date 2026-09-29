import { useEffect, useState } from 'react';
import { copyText } from '../../Markdown';
import type { TranscriptModelItem } from '../../transcript';
import {
  HighlightedLine,
  normalizedResultText,
} from './inspector/tool-preview';
import { PreviewTruncation, sourceTruncated } from './inspector/truncation';
import { SPECIALIZED_PREVIEW_MAX_TEXT } from './inspector/types';

type Tool = NonNullable<TranscriptModelItem['tool']>;

export function CodemodeScript({ tool }: { tool: Tool }) {
  const args = tool.arguments;
  const code =
    args &&
    typeof args === 'object' &&
    'code' in args &&
    typeof args.code === 'string'
      ? args.code
      : undefined;
  const truncatedSource = sourceTruncated({ ...tool }, 'arguments');
  const [formatted, setFormatted] = useState<{
    source: string;
    text: string;
  }>();
  const [copiedSource, setCopiedSource] = useState<string>();
  useEffect(() => {
    if (
      code === undefined ||
      code.length > SPECIALIZED_PREVIEW_MAX_TEXT ||
      truncatedSource
    )
      return;
    let current = true;
    void Promise.all([
      import('prettier/standalone'),
      import('prettier/plugins/babel'),
      import('prettier/plugins/estree'),
    ])
      .then(async ([prettier, babel, estree]) => {
        const text = await prettier.format(code, {
          parser: 'babel',
          plugins: [babel.default, estree.default],
        });
        if (current) setFormatted({ source: code, text });
      })
      .catch(() => {
        /* Invalid/incomplete code stays readable as original source. */
      });
    return () => {
      current = false;
    };
  }, [code, truncatedSource]);
  if (code === undefined)
    return <p className="tool-empty-content">Script source is unavailable.</p>;
  const display = formatted?.source === code ? formatted.text : code;
  return (
    <section className="codemode-script" aria-label="Codemode script">
      <div className="codemode-script-controls">
        <small>
          {formatted?.source === code
            ? 'Formatted for display'
            : 'Original source'}
        </small>
        <button
          type="button"
          aria-label="Copy original code"
          onClick={async () => {
            try {
              await copyText(code);
              setCopiedSource(code);
            } catch {
              /* Clipboard denial must not affect the transcript. */
            }
          }}
        >
          {copiedSource === code ? 'Copied' : 'Copy original code'}
        </button>
      </div>
      <pre className="tool-code-preview">
        <HighlightedLine
          language="javascript"
          value={display.slice(0, SPECIALIZED_PREVIEW_MAX_TEXT)}
        />
      </pre>
      <PreviewTruncation
        label="Code"
        sourceTruncated={truncatedSource}
        textTruncated={
          code.length > SPECIALIZED_PREVIEW_MAX_TEXT ||
          display.length > SPECIALIZED_PREVIEW_MAX_TEXT
        }
      />
    </section>
  );
}

export function CodemodeOutput({ tool }: { tool: Tool }) {
  const output = normalizedResultText(tool.result);
  if (tool.result === undefined) return null;
  return (
    <details className="codemode-output">
      <summary>Script output</summary>
      <section className="payload-section" aria-label="Script output">
        {output ? (
          <pre className="tool-terminal-output">{output.text}</pre>
        ) : (
          <p className="tool-empty-content">No text output</p>
        )}
        <PreviewTruncation
          label="Script output"
          sourceTruncated={sourceTruncated({ ...tool }, 'result')}
          textTruncated={output?.truncated ?? false}
        />
      </section>
    </details>
  );
}
