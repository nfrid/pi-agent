import {
  CodeView,
  type CodeViewHandle,
  type FileContents,
} from '@pierre/diffs/react';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { copyText, Markdown } from '../../Markdown';
import styles from './file-viewer.module.css';
import { FileLinkContext } from './link-context';
import type { FileLocation } from './reference';

type ViewerMode = 'source' | 'preview';
type ViewerEntry = {
  location: FileLocation;
  mode: ViewerMode;
  scrollTop: number;
};
type ReadFileClient = {
  readFile(
    input: { path: string; cwd?: string },
    signal?: AbortSignal,
  ): Promise<{ path: string; content: string }>;
};

export function FileViewer({
  client,
  entry,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onClose,
  onEntryChange,
}: {
  client: ReadFileClient;
  entry: ViewerEntry;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onClose: () => void;
  onEntryChange: (
    patch: Partial<Pick<ViewerEntry, 'mode' | 'scrollTop'>>,
  ) => void;
}) {
  const [file, setFile] = useState<{ path: string; content: string }>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [copied, setCopied] = useState(false);
  const [headingFound, setHeadingFound] = useState<boolean | undefined>();
  const previewRef = useRef<HTMLDivElement>(null);
  const codeViewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
  const requestId = useRef(0);
  const markdown = /\.(?:md|markdown)$/i.test(entry.location.path);
  const targetLine = entry.location.startLine;
  const selectedRange = useMemo(() => {
    if (!file || targetLine === undefined) return undefined;
    const lineCount =
      file.content === '' ? 0 : file.content.split(/\r\n|\r|\n/).length;
    const end = entry.location.endLine ?? targetLine;
    if (targetLine < 1 || end < targetLine || end > lineCount) return undefined;
    return { start: targetLine, end };
  }, [entry.location.endLine, file, targetLine]);
  const targetOutOfRange =
    targetLine !== undefined &&
    file !== undefined &&
    selectedRange === undefined;

  useEffect(() => {
    void refreshToken;
    const id = ++requestId.current;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setFile(undefined);
    void client
      .readFile(
        { path: entry.location.path, cwd: entry.location.cwd },
        controller.signal,
      )
      .then((result) => {
        if (id !== requestId.current) return;
        setFile(result);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current || controller.signal.aborted) return;
        setError(
          cause instanceof Error ? cause.message : 'Could not read this file.',
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [client, entry.location.cwd, entry.location.path, refreshToken]);

  useEffect(() => {
    if (!file || entry.mode !== 'preview') return;
    setHeadingFound(undefined);
    const frame = requestAnimationFrame(() => {
      if (!previewRef.current) return;
      if (entry.location.heading) {
        const heading = previewRef.current.querySelector<HTMLElement>(
          `#file-heading-${CSS.escape(entry.location.heading)}`,
        );
        setHeadingFound(Boolean(heading));
        if (heading) heading.scrollIntoView({ block: 'center' });
        else previewRef.current.scrollTop = entry.scrollTop;
      } else {
        setHeadingFound(true);
        previewRef.current.scrollTop = entry.scrollTop;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [entry.location.heading, entry.mode, entry.scrollTop, file]);

  useEffect(() => {
    if (
      !file ||
      entry.mode !== 'source' ||
      targetLine === undefined ||
      !selectedRange ||
      !codeViewRef.current
    )
      return;
    const frame = requestAnimationFrame(() => {
      const selection = { id: 'file', range: selectedRange };
      codeViewRef.current?.setSelectedLines(selection);
      codeViewRef.current?.scrollTo({
        type: 'range',
        id: 'file',
        range: selectedRange,
        align: 'center',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [entry.mode, file, selectedRange, targetLine]);

  const fileContents = file
    ? ({ name: file.path, contents: file.content } satisfies FileContents)
    : undefined;
  const setMode = (mode: ViewerMode) => onEntryChange({ mode });
  const refresh = () => {
    setCopied(false);
    setRefreshToken((current) => current + 1);
  };
  const copyPath = async () => {
    try {
      await copyText(file?.path ?? entry.location.path);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={styles.viewer}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.eyebrow}>File viewer</span>
          <h2 title={file?.path ?? entry.location.path}>
            {file?.path ?? entry.location.path}
          </h2>
          <span className={styles.diskStatus} role="status">
            {loading ? 'Loading…' : error ? 'Unavailable' : 'Current on disk'}
          </span>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            onClick={onBack}
            disabled={!canGoBack}
            aria-label="Back"
          >
            ← Back
          </button>
          <button
            type="button"
            onClick={onForward}
            disabled={!canGoForward}
            aria-label="Forward"
          >
            Forward →
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            aria-label="Refresh file"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void copyPath()}
            aria-label="Copy path"
          >
            {copied ? 'Copied' : 'Copy path'}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close file viewer"
          >
            Close
          </button>
        </div>
      </header>
      {markdown && (
        <fieldset className={styles.modeControls}>
          <legend>File view mode</legend>
          <button
            type="button"
            aria-label="Preview"
            aria-pressed={entry.mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            aria-label="Source"
            aria-pressed={entry.mode === 'source'}
            onClick={() => setMode('source')}
          >
            Source
          </button>
        </fieldset>
      )}
      <div className={styles.content}>
        {loading && (
          <div className={styles.message} role="status">
            Reading current file from disk…
          </div>
        )}
        {!loading && error && (
          <div className={styles.message} role="alert">
            <strong>Could not read file</strong>
            <p>{error}</p>
            <button type="button" onClick={refresh}>
              Try again
            </button>
          </div>
        )}
        {!loading && !error && file && entry.mode === 'preview' && markdown && (
          <div
            className={`${styles.preview} markdown`}
            ref={previewRef}
            onScroll={(event) =>
              onEntryChange({ scrollTop: event.currentTarget.scrollTop })
            }
          >
            <MarkdownWithLocalOptions path={file.path}>
              {file.content}
            </MarkdownWithLocalOptions>
            {entry.location.heading && headingFound === false && (
              <p className={styles.message} role="status">
                Heading not found in this file.
              </p>
            )}
          </div>
        )}
        {!loading && !error && file && entry.mode === 'source' && (
          <>
            {targetOutOfRange && (
              <div className={styles.rangeNotice} role="status">
                Lines {targetLine}–{entry.location.endLine ?? targetLine} are
                outside this file (
                {file.content === ''
                  ? 0
                  : file.content.split(/\r\n|\r|\n/).length}{' '}
                lines); showing the file without a selection.
              </div>
            )}
            <div className={styles.code}>
              {fileContents && (
                <CodeView
                  ref={codeViewRef}
                  items={[{ id: 'file', type: 'file', file: fileContents }]}
                  className={styles.codeView}
                  options={{ theme: 'dracula', disableFileHeader: true }}
                  selectedLines={
                    selectedRange ? { id: 'file', range: selectedRange } : null
                  }
                  onScroll={(scrollTop) => onEntryChange({ scrollTop })}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Keeps the viewer coupled to the existing renderer while allowing its local safety props to land independently. */
function parentDirectory(path: string): string | undefined {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (separator < 0) return undefined;
  return path.slice(0, separator) || path.slice(0, 1);
}

function MarkdownWithLocalOptions({
  path,
  children,
}: {
  path: string;
  children: string;
}) {
  return (
    <FileLinkContext.Provider value={{ cwd: parentDirectory(path), path }}>
      <MarkdownWithOptions headingIds allowImages={false}>
        {children}
      </MarkdownWithOptions>
    </FileLinkContext.Provider>
  );
}

const MarkdownWithOptions = Markdown as unknown as (props: {
  children: string;
  headingIds?: boolean;
  allowImages?: boolean;
}) => ReactElement;
