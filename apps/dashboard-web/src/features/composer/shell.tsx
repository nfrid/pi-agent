import type { MDXEditorMethods } from '@mdxeditor/editor';
import {
  type ClipboardEventHandler,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  Suspense,
  useLayoutEffect,
  useRef,
} from 'react';
import { Button as AriaButton } from 'react-aria-components';
import type { ComposerCommandOption } from '../composer-autocomplete';
import type { ImageAttachment } from './attachments';
import { ImageAttachmentInput, ImageAttachmentPreviews } from './attachments';
import { MarkdownComposerEditor } from './editor';

function submitOnShortcut(
  event: KeyboardEvent<HTMLElement>,
  submissionDisabled: boolean,
) {
  if (
    submissionDisabled ||
    event.key !== 'Enter' ||
    (!event.metaKey && !event.ctrlKey) ||
    event.currentTarget.querySelector('[role="listbox"]') ||
    event.shiftKey
  )
    return;
  event.preventDefault();
  event.currentTarget.closest('form')?.requestSubmit();
}

export function ComposerRichSurface({
  onPasteCapture,
  submissionDisabled = false,
  children,
}: {
  onPasteCapture: ClipboardEventHandler<HTMLElement>;
  submissionDisabled?: boolean;
  children: ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const actions = surface?.querySelector<HTMLElement>('.composer-actions');
    if (!surface || !actions) return;

    const reserveActionSpace = () => {
      surface.style.setProperty(
        '--composer-actions-width',
        `${actions.offsetWidth}px`,
      );
      surface.style.setProperty(
        '--composer-actions-height',
        `${actions.offsetHeight}px`,
      );
    };

    reserveActionSpace();
    const observer = new ResizeObserver(reserveActionSpace);
    observer.observe(actions);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={surfaceRef}
      className="composer-primary composer-rich-surface"
      onPasteCapture={onPasteCapture}
      onKeyDownCapture={(event) => submitOnShortcut(event, submissionDisabled)}
    >
      {children}
    </div>
  );
}

export function ComposerShell({
  className,
  ariaLabel,
  onSubmit,
  dragging = false,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  attachmentsEnabled,
  attachmentsBusy,
  fileInputRef,
  attachments,
  onSelectImages,
  onRemoveImage,
  onPasteCapture,
  editorRef,
  commands,
  onChange,
  placeholder,
  readOnly,
  initialMarkdown,
  submissionDisabled = false,
  sendDisabled,
  sendAriaLabel,
  sendSrOnly,
  actionExtras,
  mode,
  controls,
  footer,
}: {
  className?: string;
  ariaLabel: string;
  onSubmit: (event: FormEvent) => void;
  dragging?: boolean;
  onDragEnter: React.DragEventHandler;
  onDragOver: React.DragEventHandler;
  onDragLeave: React.DragEventHandler;
  onDrop: React.DragEventHandler;
  attachmentsEnabled: boolean;
  attachmentsBusy: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  attachments: readonly ImageAttachment[];
  onSelectImages: (files: readonly File[]) => void;
  onRemoveImage: (id: string) => void;
  onPasteCapture: ClipboardEventHandler<HTMLElement>;
  editorRef: RefObject<MDXEditorMethods | null>;
  commands?: readonly ComposerCommandOption[];
  onChange: (value: string) => void;
  placeholder: string;
  readOnly: boolean;
  initialMarkdown?: string;
  submissionDisabled?: boolean;
  sendDisabled: boolean;
  sendAriaLabel: string;
  sendSrOnly?: string;
  actionExtras?: ReactNode;
  mode: ReactNode;
  controls: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <form
      className={`composer${dragging ? ' dragging' : ''}${className ? ` ${className}` : ''}`}
      aria-label={ariaLabel}
      onSubmit={onSubmit}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ImageAttachmentInput
        enabled={attachmentsEnabled}
        busy={attachmentsBusy}
        inputRef={fileInputRef}
        onFiles={onSelectImages}
      />
      <ImageAttachmentPreviews
        attachments={attachments}
        busy={attachmentsBusy}
        onRemove={onRemoveImage}
      />
      <ComposerRichSurface
        onPasteCapture={onPasteCapture}
        submissionDisabled={submissionDisabled}
      >
        <Suspense
          fallback={
            <output className="composer-editor-loading">Loading editor…</output>
          }
        >
          <MarkdownComposerEditor
            ref={editorRef}
            {...(initialMarkdown === undefined ? {} : { initialMarkdown })}
            commands={commands}
            onChange={onChange}
            placeholder={placeholder}
            readOnly={readOnly}
          />
        </Suspense>
        <div className="composer-actions">
          <AriaButton
            type="button"
            className="composer-attach"
            isDisabled={!attachmentsEnabled || attachmentsBusy}
            onPress={() => fileInputRef.current?.click()}
            aria-label={
              attachmentsEnabled
                ? 'Attach images'
                : 'Attach images (unsupported by selected model)'
            }
          >
            <span aria-hidden="true">＋</span>
            <span className="composer-attach-label">Image</span>
          </AriaButton>
          <AriaButton
            type="submit"
            className="composer-send"
            isDisabled={sendDisabled}
            aria-label={sendAriaLabel}
          >
            <span aria-hidden="true">↑</span>
            {sendSrOnly && <span className="sr-only">{sendSrOnly}</span>}
          </AriaButton>
          {actionExtras}
        </div>
      </ComposerRichSurface>
      <div className="composer-secondary">
        <div className="composer-mode">{mode}</div>
        <div className="composer-control-row">{controls}</div>
        {footer}
      </div>
    </form>
  );
}
