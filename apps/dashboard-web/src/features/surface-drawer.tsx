import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type TouchEvent,
  useId,
} from 'react';
import { Dialog as AriaDialog, ModalOverlay } from 'react-aria-components';
import { useOverlayFocusRestore, useOverlayPresence } from './overlay-presence';
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

export function SurfaceDrawer({
  title,
  onClose,
  children,
  headerContent,
  headerSummary,
  eyebrow = 'Live work',
  hideTitle = false,
  className = 'surface-drawer',
  layerClassName = 'surface-drawer-layer',
  drawerId,
  titleId: providedTitleId,
  closeLabel,
  isOpen = true,
  paused = false,
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
  drawerId?: string;
  titleId?: string;
  closeLabel?: string;
  isOpen?: boolean;
  paused?: boolean;
}) {
  const generatedTitleId = useId();
  const titleId = providedTitleId ?? generatedTitleId;
  const resolvedCloseLabel = closeLabel ?? `Close ${title}`;
  const { present, exiting } = useOverlayPresence(isOpen);
  const swipeHandlers = useSwipeToDismiss(onClose);
  useOverlayFocusRestore(isOpen);
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
      {/* FocusScope owns focus; this wrapper forwards Escape from the drawer. */}
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
          id={drawerId}
          className={className}
          aria-labelledby={titleId}
          aria-modal="true"
          data-swipe-dismiss="right"
          data-runtime-paused={paused ? '' : undefined}
        >
          <header className="surface-drawer-header">
            <div className="surface-drawer-heading">
              <p className="eyebrow" id={hideTitle ? titleId : undefined}>
                {eyebrow}
              </p>
              {!hideTitle && <h2 id={titleId}>{title}</h2>}
              {headerSummary && (
                <div className="surface-drawer-summary">{headerSummary}</div>
              )}
            </div>
            {headerContent && (
              <div className="surface-drawer-header-content">
                {headerContent}
              </div>
            )}
            <button
              type="button"
              className="session-icon-button"
              aria-label={resolvedCloseLabel}
              onClick={onClose}
            >
              ×
            </button>
          </header>
          <div className="surface-drawer-body">{children}</div>
        </AriaDialog>
      </div>
    </ModalOverlay>
  );
}

/** Session-mode agent nav overlay shell (handle, backdrop, drawer wrapper). */
export function AgentNavDrawerShell({
  open,
  onOpenChange,
  isMobile,
  drawerPresent,
  drawerExiting,
  handleRef,
  drawerClassName,
  onTouchStart,
  onTouchEnd,
  children,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  isMobile: boolean;
  drawerPresent: boolean;
  drawerExiting: boolean;
  handleRef: RefObject<HTMLButtonElement | null>;
  drawerClassName?: string;
  onTouchStart?: (event: TouchEvent) => void;
  onTouchEnd?: (event: TouchEvent) => void;
  children: ReactNode;
}) {
  return (
    <>
      <button
        ref={handleRef}
        type="button"
        className="agent-nav-handle"
        aria-label="Open agent list"
        onClick={() => onOpenChange?.(true)}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        ‹
      </button>
      {drawerPresent && (
        <button
          type="button"
          className={`agent-nav-backdrop${drawerExiting ? ' is-exiting' : ''}`}
          aria-label="Close agent list"
          onClick={() => onOpenChange?.(false)}
        />
      )}
      {(!isMobile || drawerPresent) && (
        <div
          className={`agent-nav-drawer ${drawerClassName ?? ''} ${open ? 'open' : ''}${drawerExiting ? ' is-exiting' : ''}`}
          aria-hidden={isMobile && !open ? true : undefined}
        >
          {children}
        </div>
      )}
    </>
  );
}
