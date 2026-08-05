import { type KeyboardEvent, type ReactNode, useId } from 'react';
import { Dialog as AriaDialog, ModalOverlay } from 'react-aria-components';
import { useOverlayPresence } from './overlay-presence';

/** Shared overlay primitive for dashboard sheets and panels. */
export function DashboardDialog({
  title,
  onClose,
  children,
  eyebrow = 'Live work',
  className = 'surface-dialog',
  layerClassName = 'surface-dialog-layer',
  isOpen = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  eyebrow?: string;
  className?: string;
  layerClassName?: string;
  isOpen?: boolean;
}) {
  const titleId = useId();
  const { present, exiting } = useOverlayPresence(isOpen);
  if (!present) return null;
  return (
    <ModalOverlay
      isOpen
      isExiting={exiting}
      isDismissable
      className={({ isExiting }) =>
        `${layerClassName}${isExiting || exiting ? ' is-exiting' : ''}`
      }
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      {/* FocusScope owns focus; this wrapper forwards Escape from the dialog. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard dismissal is delegated from the Aria dialog focus scope. */}
      <div
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <AriaDialog
          className={className}
          aria-labelledby={titleId}
          aria-modal="true"
        >
          <header className="surface-dialog-header">
            <div>
              <p className="eyebrow">{eyebrow}</p>
              <h2 id={titleId}>{title}</h2>
            </div>
            <button
              type="button"
              className="session-icon-button"
              aria-label={`Close ${title}`}
              onClick={onClose}
            >
              ×
            </button>
          </header>
          <div className="surface-dialog-body">{children}</div>
        </AriaDialog>
      </div>
    </ModalOverlay>
  );
}
