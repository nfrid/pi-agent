import type { ClipboardEventHandler, KeyboardEvent, ReactNode } from 'react';

function submitOnShortcut(event: KeyboardEvent<HTMLElement>) {
  if (
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
  children,
}: {
  onPasteCapture: ClipboardEventHandler<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <div
      className="composer-primary composer-rich-surface"
      onPasteCapture={onPasteCapture}
      onKeyDownCapture={submitOnShortcut}
    >
      {children}
    </div>
  );
}
