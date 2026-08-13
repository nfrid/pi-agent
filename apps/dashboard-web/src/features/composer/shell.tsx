import type { ClipboardEventHandler, KeyboardEvent, ReactNode } from 'react';

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
  return (
    <div
      className="composer-primary composer-rich-surface"
      onPasteCapture={onPasteCapture}
      onKeyDownCapture={(event) => submitOnShortcut(event, submissionDisabled)}
    >
      {children}
    </div>
  );
}
