import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from 'react';
import { Dialog as AriaDialog, ModalOverlay } from 'react-aria-components';
import { useOverlayPresence } from './overlay-presence';
import { useSwipeToDismiss } from './swipe-to-dismiss';

/** Shared overlay primitive for dashboard sheets and panels. */
export function SurfaceStats({
  stats,
  className,
  showZero = false,
}: {
  stats: readonly { label: string; value: number; tone?: string }[];
  className?: string;
  showZero?: boolean;
}) {
  return (
    <div
      className={`surface-stats${className ? ` ${className}` : ''}`}
      role="status"
      aria-label="Status summary"
    >
      {stats
        .filter((stat) => showZero || stat.value > 0)
        .map((stat) => (
          <span className={stat.tone} key={stat.label}>
            <strong>{stat.value}</strong> {stat.label}
          </span>
        ))}
    </div>
  );
}

export function DashboardDialog({
  title,
  onClose,
  children,
  headerContent,
  headerSummary,
  eyebrow = 'Live work',
  hideTitle = false,
  className = 'surface-dialog',
  layerClassName = 'surface-dialog-layer',
  isOpen = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  headerContent?: ReactNode;
  headerSummary?: ReactNode;
  eyebrow?: string;
  hideTitle?: boolean;
  className?: string;
  layerClassName?: string;
  isOpen?: boolean;
}) {
  const titleId = useId();
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const { present, exiting } = useOverlayPresence(isOpen);
  const swipeHandlers = useSwipeToDismiss(onClose);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      wasOpenRef.current = true;
      return;
    }
    if (!isOpen && wasOpenRef.current) {
      const previous = previousFocusRef.current;
      if (previous?.isConnected && previous.getClientRects().length > 0)
        previous.focus({ preventScroll: true });
      previousFocusRef.current = null;
      wasOpenRef.current = false;
    }
  }, [isOpen]);
  if (!present) return null;
  return (
    <ModalOverlay
      isOpen
      isExiting={exiting}
      isDismissable
      aria-hidden={exiting || undefined}
      inert={exiting || undefined}
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
      <div
        aria-hidden={exiting || undefined}
        inert={exiting || undefined}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <AriaDialog
          ref={swipeHandlers.ref}
          className={className}
          aria-labelledby={titleId}
          aria-modal="true"
          data-swipe-dismiss="right"
        >
          <header className="surface-dialog-header">
            <div className="surface-dialog-heading">
              <p className="eyebrow" id={hideTitle ? titleId : undefined}>
                {eyebrow}
              </p>
              {!hideTitle && <h2 id={titleId}>{title}</h2>}
              {headerSummary && (
                <div className="surface-dialog-summary">{headerSummary}</div>
              )}
            </div>
            {headerContent && (
              <div className="surface-dialog-header-content">
                {headerContent}
              </div>
            )}
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
