import type { DashboardHttpClient } from '@pi-dashboard/client';
import {
  CodeView,
  type CodeViewHandle,
  type FileContents,
} from '@pierre/diffs/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyText, Markdown } from '../../Markdown';
import styles from './file-viewer.module.css';
import { FileLinkContext } from './link-context';
import { fileLocationKey, type ViewerEntry, type ViewerMode } from './model';
import type { FileLocation } from './reference';

type FileReadResult = Awaited<ReturnType<DashboardHttpClient['readFile']>>;

type SourceSelection = { id: string; range: { start: number; end: number } };

function fileLineCount(content: string): number {
  if (content === '') return 0;
  const count = content.split(/\r\n|\r|\n/).length;
  return /(?:\r\n|\r|\n)$/.test(content) ? count - 1 : count;
}

function parentDirectory(path: string): string | undefined {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (separator < 0) return undefined;
  return path.slice(0, separator) || path.slice(0, 1);
}

export function FileViewer({
  client,
  entry,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onClose,
  onModeChange,
  onScroll,
}: {
  client: DashboardHttpClient;
  entry: ViewerEntry;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onClose: () => void;
  onModeChange: (mode: ViewerMode) => void;
  onScroll: (
    location: FileLocation,
    mode: ViewerMode,
    scrollTop: number,
  ) => void;
}) {
  const [file, setFile] = useState<FileReadResult>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [copied, setCopied] = useState(false);
  const [headingFound, setHeadingFound] = useState<boolean | undefined>();
  const previewRef = useRef<HTMLDivElement>(null);
  const codeViewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
  const requestId = useRef(0);
  const restoredVisit = useRef<string | undefined>(undefined);
  const markdown = /\.(?:md|markdown)$/i.test(entry.location.path);
  const destinationKey = fileLocationKey(entry.location);
  const targetLine = entry.location.startLine;
  const selectedRange = useMemo(() => {
    if (!file || targetLine === undefined) return undefined;
    const end = entry.location.endLine ?? targetLine;
    const lineCount = fileLineCount(file.content);
    if (targetLine < 1 || end < targetLine || end > lineCount) return undefined;
    return { start: targetLine, end };
  }, [entry.location.endLine, file, targetLine]);
  const targetOutOfRange =
    targetLine !== undefined &&
    file !== undefined &&
    selectedRange === undefined;
  const savedScrollTop = entry.scrollTop[entry.mode];
  const fileContents = useMemo<FileContents | undefined>(
    () => (file ? { name: file.path, contents: file.content } : undefined),
    [file],
  );
  const items = useMemo(
    () =>
      fileContents
        ? [{ id: 'file', type: 'file' as const, file: fileContents }]
        : [],
    [fileContents],
  );
  const options = useMemo(
    () => ({ theme: 'dracula' as const, disableFileHeader: true }),
    [],
  );
  const sourceSelection = useMemo<SourceSelection | null>(
    () => (selectedRange ? { id: 'file', range: selectedRange } : null),
    [selectedRange],
  );

  useEffect(() => {
    void destinationKey;
    void refreshToken;
    setCopied(false);
    setHeadingFound(undefined);
    restoredVisit.current = undefined;
  }, [destinationKey, refreshToken]);

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
        if (id !== requestId.current || controller.signal.aborted) return;
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
    const visitKey = `${destinationKey}:preview:${refreshToken}`;
    if (restoredVisit.current === visitKey) return;
    const frame = requestAnimationFrame(() => {
      if (!previewRef.current) return;
      restoredVisit.current = visitKey;
      const heading = entry.location.heading
        ? previewRef.current.querySelector<HTMLElement>(
            `#file-heading-${CSS.escape(entry.location.heading)}`,
          )
        : undefined;
      if (entry.location.heading) setHeadingFound(Boolean(heading));
      else setHeadingFound(true);
      if (savedScrollTop !== undefined) {
        previewRef.current.scrollTop = savedScrollTop;
      } else if (heading) {
        heading.scrollIntoView({ block: 'center' });
      } else {
        previewRef.current.scrollTop = 0;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    destinationKey,
    entry.location.heading,
    entry.mode,
    file,
    refreshToken,
    savedScrollTop,
  ]);

  useEffect(() => {
    if (!file || entry.mode !== 'source' || !codeViewRef.current) return;
    const visitKey = `${destinationKey}:source:${refreshToken}`;
    if (restoredVisit.current === visitKey) return;
    const frame = requestAnimationFrame(() => {
      if (!codeViewRef.current) return;
      restoredVisit.current = visitKey;
      if (savedScrollTop !== undefined) {
        codeViewRef.current.scrollTo({
          type: 'position',
          position: savedScrollTop,
          behavior: 'instant',
        });
      } else if (selectedRange) {
        codeViewRef.current.scrollTo({
          type: 'range',
          id: 'file',
          range: selectedRange,
          align: 'center',
          behavior: 'instant',
        });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    destinationKey,
    entry.mode,
    file,
    refreshToken,
    savedScrollTop,
    selectedRange,
  ]);

  const handlePreviewScroll = useCallback(
    (scrollTop: number) => onScroll(entry.location, 'preview', scrollTop),
    [entry.location, onScroll],
  );
  const handleSourceScroll = useCallback(
    (scrollTop: number) => onScroll(entry.location, 'source', scrollTop),
    [entry.location, onScroll],
  );
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
            onClick={() => onModeChange('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            aria-label="Source"
            aria-pressed={entry.mode === 'source'}
            onClick={() => onModeChange('source')}
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
              handlePreviewScroll(event.currentTarget.scrollTop)
            }
          >
            <FileLinkContext.Provider
              value={{ cwd: parentDirectory(file.path), path: file.path }}
            >
              <Markdown headingIds allowImages={false}>
                {file.content}
              </Markdown>
            </FileLinkContext.Provider>
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
                outside this file ({fileLineCount(file.content)} lines); showing
                the file without a selection.
              </div>
            )}
            <div className={styles.code}>
              <CodeView
                ref={codeViewRef}
                items={items}
                className={styles.codeView}
                options={options}
                selectedLines={sourceSelection}
                onScroll={handleSourceScroll}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
