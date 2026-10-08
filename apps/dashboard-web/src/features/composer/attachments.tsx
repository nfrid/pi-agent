import {
  type ClipboardEvent,
  type DragEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  addFileAttachments,
  type FileAttachment,
  formatAttachmentSize,
  isNativeImage,
} from '../../shared/file-attachments';
import { setDraftAttachmentCount } from '../drafts';

export type { FileAttachment } from '../../shared/file-attachments';
export {
  addFileAttachments,
  hasNativeImages,
  isNativeImage,
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_SIZE,
  NATIVE_IMAGE_TYPES,
  nativeImageCount,
} from '../../shared/file-attachments';

export function FileAttachmentInput({
  enabled,
  busy,
  inputRef,
  onFiles,
}: {
  enabled: boolean;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: readonly File[]) => void;
}) {
  if (!enabled) return null;
  return (
    <input
      ref={inputRef}
      className="sr-only"
      type="file"
      multiple
      aria-label="Choose files"
      disabled={busy}
      onChange={(event) => {
        onFiles(Array.from(event.target.files ?? []));
        event.target.value = '';
      }}
    />
  );
}

export function FileAttachmentPreviews({
  attachments,
  busy,
  onRemove,
}: {
  attachments: readonly FileAttachment[];
  busy: boolean;
  onRemove: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <fieldset className="composer-previews">
      <legend className="sr-only">Attachments</legend>
      {attachments.map(({ id, file, previewUrl }) => (
        <div
          className={`composer-preview${previewUrl ? '' : ' composer-file-preview-card'}`}
          key={id}
        >
          {previewUrl ? (
            <img src={previewUrl} alt={file.name} />
          ) : (
            <span className="composer-file-preview">
              <span className="composer-file-name">{file.name}</span>
              <span className="composer-file-size">
                {formatAttachmentSize(file.size)}
              </span>
            </span>
          )}
          <button
            type="button"
            aria-label={`Remove ${file.name}`}
            disabled={busy}
            onClick={() => onRemove(id)}
          >
            ×
          </button>
        </div>
      ))}
    </fieldset>
  );
}

export function useFileAttachments({
  enabled,
  busy,
  onError,
  draftId,
  clearOnDisable = true,
}: {
  enabled: boolean;
  busy: boolean;
  onError: (error: string | undefined) => void;
  draftId?: string;
  clearOnDisable?: boolean;
}) {
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const attachmentsRef = useRef<FileAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);
  const nextAttachmentId = useRef(0);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const recordAttachmentCount = useCallback(
    (count: number) => {
      if (draftId) setDraftAttachmentCount(draftId, count);
    },
    [draftId],
  );
  const clearAttachments = useCallback(() => {
    for (const attachment of attachmentsRef.current)
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    attachmentsRef.current = [];
    if (mountedRef.current) {
      recordAttachmentCount(0);
      setAttachments([]);
    }
  }, [recordAttachmentCount]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled && clearOnDisable) clearAttachments();
  }, [clearAttachments, clearOnDisable, enabled]);
  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current)
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      attachmentsRef.current = [];
      if (draftId) setDraftAttachmentCount(draftId, 0);
    },
    [draftId],
  );

  const selectFiles = useCallback(
    (files: readonly File[]) => {
      if (!enabled || busy) return;
      const result = addFileAttachments(
        attachmentsRef.current.map((attachment) => attachment.file),
        files,
      );
      if (result.accepted.length) {
        const added = result.accepted.map((file) => ({
          id: String(nextAttachmentId.current++),
          file,
          ...(isNativeImage(file)
            ? { previewUrl: URL.createObjectURL(file) }
            : {}),
        }));
        attachmentsRef.current = [...attachmentsRef.current, ...added];
        recordAttachmentCount(attachmentsRef.current.length);
        setAttachments((current) => [...current, ...added]);
      }
      onError(result.error);
    },
    [busy, enabled, onError, recordAttachmentCount],
  );

  const removeFile = useCallback(
    (id: string) => {
      const attachment = attachmentsRef.current.find(
        (candidate) => candidate.id === id,
      );
      if (!attachment) return;
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      attachmentsRef.current = attachmentsRef.current.filter(
        (candidate) => candidate !== attachment,
      );
      recordAttachmentCount(attachmentsRef.current.length);
      setAttachments((current) =>
        current.filter((candidate) => candidate !== attachment),
      );
    },
    [recordAttachmentCount],
  );

  const onDragEnter = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || busy) return;
      event.preventDefault();
      setDragging(true);
    },
    [busy, enabled],
  );
  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || busy) return;
      event.preventDefault();
    },
    [busy, enabled],
  );
  const onDragLeave = useCallback(() => setDragging(false), []);
  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || busy) return;
      event.preventDefault();
      setDragging(false);
      selectFiles(Array.from(event.dataTransfer.files));
    },
    [busy, enabled, selectFiles],
  );
  const onPasteCapture = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      if (!enabled || busy) return;
      const files = Array.from(event.clipboardData.files);
      const itemFiles = Array.from(event.clipboardData.items).flatMap(
        (item) => {
          const file = item.kind === 'file' ? item.getAsFile() : null;
          return file ? [file] : [];
        },
      );
      const clipboardFiles = files.length ? files : itemFiles;
      if (!clipboardFiles.length) return;
      event.preventDefault();
      selectFiles(clipboardFiles);
    },
    [busy, enabled, selectFiles],
  );

  return {
    attachments,
    dragging,
    fileInputRef,
    selectFiles,
    removeFile,
    clearAttachments,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onPasteCapture,
  };
}
