import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type TouchEvent,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import { Dialog as AriaDialog, ModalOverlay } from 'react-aria-components';
import { useSurfaceHistory } from './drawer-history';
import { useOverlayFocusRestore, useOverlayPresence } from './overlay-presence';
import { useSwipeToDismiss } from './swipe-to-dismiss';

export type SurfaceKind = 'utility' | 'work' | 'inspector';
export type SurfaceSize = 'compact' | 'wide';

export type SurfacePage = {
  id: string;
  title: string;
  children: ReactNode;
  eyebrow?: string | null;
  headerContent?: ReactNode;
  headerSummary?: ReactNode;
  hideTitle?: boolean;
  hideHeader?: boolean;
  backLabel?: string;
  closeLabel?: string;
  initialFocus?: string;
};

/** Shared status summary used by work surfaces and future utility panels. */
export function SurfaceStats({
  stats,
  className,
  showZero = false,
}: {
  stats: readonly { label: string; value: number; tone?: string }[];
  className?: string;
  showZero?: boolean;
}) {
  const visibleStats = stats.filter((stat) => showZero || stat.value > 0);
  return (
    <div
      className={`surface-stats${className ? ` ${className}` : ''}`}
      role="status"
      aria-label={visibleStats
        .map((stat) => `${stat.value} ${stat.label}`)
        .join(', ')}
    >
      {visibleStats.map((stat) => (
        <span className={stat.tone} key={stat.label} aria-hidden="true">
          <span className="surface-stat-glyph">
            {surfaceStatGlyph(stat.label)}
          </span>
          <strong>{stat.value}</strong>{' '}
          <span className="surface-stat-label">{stat.label}</span>
        </span>
      ))}
    </div>
  );
}

function surfaceStatGlyph(label: string): string {
  if (label === 'running' || label === 'active') return '●';
  if (label === 'queued') return '○';
  if (label === 'failed') return '!';
  if (label === 'stopped') return '■';
  if (label === 'done' || label === 'finished') return '✓';
  return '•';
}

/**
 * One adaptive overlay with a mounted page stack. Covered pages stay inert so
 * list filters, selection, and scroll positions survive inspector navigation.
 */
export function SurfaceStack({
  pages,
  onDepthChange,
  onClose,
  kind = 'inspector',
  size = 'compact',
  className = 'surface-drawer',
  layerClassName = 'surface-drawer-layer',
  isOpen = true,
  paused = false,
}: {
  pages: readonly SurfacePage[];
  onDepthChange: (depth: number) => void;
  onClose: () => void;
  kind?: SurfaceKind;
  size?: SurfaceSize;
  className?: string;
  layerClassName?: string;
  isOpen?: boolean;
  paused?: boolean;
}) {
  const generatedId = useId();
  const depth = pages.length;
  const topPage = pages.at(-1);
  const topPageId = topPage?.id;
  const topPageInitialFocus = topPage?.initialFocus;
  const { present, exiting } = useOverlayPresence(isOpen);
  const dismissTop = () => {
    if (depth > 1) onDepthChange(depth - 1);
    else onClose();
  };
  const swipeHandlers = useSwipeToDismiss(dismissTop);
  const focusedByPage = useRef(new Map<string, HTMLElement>());
  const previousDepth = useRef(depth);
  const previousTopId = useRef(topPage?.id);

  useSurfaceHistory(isOpen && depth > 0, depth, (nextDepth) => {
    if (nextDepth < 1) onClose();
    else onDepthChange(nextDepth);
  });
  useOverlayFocusRestore(isOpen && depth > 0);

  useLayoutEffect(() => {
    const priorDepth = previousDepth.current;
    const priorTopId = previousTopId.current;
    previousDepth.current = depth;
    previousTopId.current = topPageId;
    if (!isOpen || !topPageId || topPageId === priorTopId) return;
    if (depth < priorDepth) {
      const previousFocus = focusedByPage.current.get(topPageId);
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
        return;
      }
    }
    const pageSelector = `[data-surface-page="${CSS.escape(topPageId)}"]`;
    document
      .querySelector<HTMLElement>(
        topPageInitialFocus
          ? `${pageSelector} ${topPageInitialFocus}`
          : `${pageSelector} button:not(:disabled), ${pageSelector} [href], ${pageSelector} input`,
      )
      ?.focus({ preventScroll: true });
  }, [depth, isOpen, topPageId, topPageInitialFocus]);

  if (!present || !topPage || depth < 1) return null;
  return (
    <ModalOverlay
      isOpen
      isExiting={exiting}
      isDismissable
      aria-hidden={exiting || undefined}
      inert={exiting || undefined}
      className={({ isExiting }: { isExiting: boolean }) =>
        `${layerClassName}${isExiting || exiting ? ' is-exiting' : ''}`
      }
      onClick={(event: MouseEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        dismissTop();
      }}
      onOpenChange={(nextOpen: boolean) => {
        if (!nextOpen) dismissTop();
      }}
    >
      <div
        aria-hidden={exiting || undefined}
        inert={exiting || undefined}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          dismissTop();
        }}
      >
        <AriaDialog
          ref={swipeHandlers.ref}
          className={className}
          aria-label={topPage.title}
          aria-modal="true"
          data-surface-kind={kind}
          data-surface-size={size}
          data-surface-depth={depth}
          data-swipe-dismiss="right"
          data-runtime-paused={paused ? '' : undefined}
        >
          <div className="surface-stack-pages">
            {pages.map((page, index) => {
              const active = index === depth - 1;
              const titleId = `${generatedId}-${index.toString(36)}`;
              return (
                <section
                  className="surface-stack-page"
                  data-surface-page={page.id}
                  data-active={active ? '' : undefined}
                  aria-hidden={!active || undefined}
                  inert={!active || undefined}
                  key={page.id}
                  onFocusCapture={(event: FocusEvent<HTMLElement>) => {
                    if (active)
                      focusedByPage.current.set(
                        page.id,
                        event.target as HTMLElement,
                      );
                  }}
                >
                  {!page.hideHeader && (
                    <header className="surface-drawer-header">
                      <div className="surface-drawer-heading">
                        {page.eyebrow !== null && (
                          <p
                            className="eyebrow"
                            id={page.hideTitle ? titleId : undefined}
                          >
                            {page.eyebrow ?? 'Dashboard'}
                          </p>
                        )}
                        {!page.hideTitle && <h2 id={titleId}>{page.title}</h2>}
                        {page.headerSummary && (
                          <div className="surface-drawer-summary">
                            {page.headerSummary}
                          </div>
                        )}
                      </div>
                      {page.headerContent && (
                        <div className="surface-drawer-header-content">
                          {page.headerContent}
                        </div>
                      )}
                      <button
                        type="button"
                        className="session-icon-button"
                        aria-label={
                          depth > 1
                            ? (page.backLabel ??
                              `Back to ${pages.at(-2)?.title ?? 'previous view'}`)
                            : (page.closeLabel ?? `Close ${page.title}`)
                        }
                        onClick={dismissTop}
                      >
                        {depth > 1 ? '←' : '×'}
                      </button>
                    </header>
                  )}
                  <div className="surface-drawer-body">{page.children}</div>
                </section>
              );
            })}
          </div>
        </AriaDialog>
      </div>
    </ModalOverlay>
  );
}

/** Session-mode agent nav overlay shell remains a specialized navigation rail. */
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
