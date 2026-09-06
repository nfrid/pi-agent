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
  addImageAttachments,
  IMAGE_TYPES,
  type ImageAttachment,
} from '../../shared/image-attachments';
import { setDraftAttachmentCount } from '../drafts';

export type { ImageAttachment } from '../../shared/image-attachments';
export {
  addImageAttachments,
  IMAGE_TYPES,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_SIZE,
  MAX_IMAGE_TOTAL_SIZE,
} from '../../shared/image-attachments';

type ImageAttachmentInputProps = {
  enabled: boolean;
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: readonly File[]) => void;
};

export function ImageAttachmentInput({
  enabled,
  busy,
  inputRef,
  onFiles,
}: ImageAttachmentInputProps) {
  if (!enabled) return null;
  return (
    <input
      ref={inputRef}
      className="sr-only"
      type="file"
      accept={IMAGE_TYPES.join(',')}
      multiple
      aria-label="Choose images"
      disabled={busy}
      onChange={(event) => {
        onFiles(Array.from(event.target.files ?? []));
        event.target.value = '';
      }}
    />
  );
}

export function ImageAttachmentPreviews({
  attachments,
  busy,
  onRemove,
}: {
  attachments: readonly ImageAttachment[];
  busy: boolean;
  onRemove: (previewUrl: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <fieldset className="composer-previews">
      <legend className="sr-only">Image attachments</legend>
      {attachments.map((attachment) => (
        <div className="composer-preview" key={attachment.previewUrl}>
          <img src={attachment.previewUrl} alt={attachment.file.name} />
          <button
            type="button"
            aria-label={`Remove ${attachment.file.name}`}
            disabled={busy}
            onClick={() => onRemove(attachment.previewUrl)}
          >
            ×
          </button>
        </div>
      ))}
    </fieldset>
  );
}

export function useImageAttachments({
  enabled,
  busy,
  onError,
  draftId,
  clearOnDisable = true,
}: {
  enabled: boolean;
  busy: boolean;
  onError: (error: string | undefined) => void;
  /** Draft metadata to protect while selected files are still held. */
  draftId?: string;
  /** Dormant resume keeps selected files while the started runtime is checked. */
  clearOnDisable?: boolean;
}) {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const attachmentsRef = useRef<ImageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);

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
      URL.revokeObjectURL(attachment.previewUrl);
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
        URL.revokeObjectURL(attachment.previewUrl);
      attachmentsRef.current = [];
      if (draftId) setDraftAttachmentCount(draftId, 0);
    },
    [draftId],
  );

  const selectImages = useCallback(
    (files: readonly File[]) => {
      if (!enabled || busy) return;
      const result = addImageAttachments(
        attachmentsRef.current.map((attachment) => attachment.file),
        files,
      );
      if (result.accepted.length) {
        const added = result.accepted.map((file) => ({
          file,
          previewUrl: URL.createObjectURL(file),
        }));
        attachmentsRef.current = [...attachmentsRef.current, ...added];
        recordAttachmentCount(attachmentsRef.current.length);
        setAttachments((current) => [...current, ...added]);
      }
      onError(result.error);
    },
    [busy, enabled, onError, recordAttachmentCount],
  );

  const removeImage = useCallback(
    (previewUrl: string) => {
      const attachment = attachmentsRef.current.find(
        (candidate) => candidate.previewUrl === previewUrl,
      );
      if (!attachment) return;
      URL.revokeObjectURL(attachment.previewUrl);
      attachmentsRef.current = attachmentsRef.current.filter(
        (candidate) => candidate.previewUrl !== previewUrl,
      );
      recordAttachmentCount(attachmentsRef.current.length);
      setAttachments((current) =>
        current.filter((candidate) => candidate.previewUrl !== previewUrl),
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
      selectImages(Array.from(event.dataTransfer.files));
    },
    [busy, enabled, selectImages],
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
      const images = files.length ? files : itemFiles;
      if (!images.length) return;
      event.preventDefault();
      selectImages(images);
    },
    [busy, enabled, selectImages],
  );

  return {
    attachments,
    dragging,
    fileInputRef,
    selectImages,
    removeImage,
    clearAttachments,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onPasteCapture,
  };
}
