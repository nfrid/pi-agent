import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { type SurfacePage, SurfaceStack } from '../surface-stack';

function focusAfterSurfaceHides(launcher: HTMLButtonElement | null) {
  if (
    !launcher ||
    (document.activeElement !== launcher &&
      document.activeElement !== document.body)
  )
    return;
  const fallback = document.querySelector<HTMLElement>(
    '[aria-label="Send a message"] [role="textbox"]',
  );
  if (fallback?.getClientRects().length)
    fallback.focus({ preventScroll: true });
}

export function WorkSurface({
  title,
  label,
  summary,
  summaryDetail,
  count,
  visibleCount,
  drawerClassName = 'surface-drawer work-surface-drawer',
  headerStats,
  paused = false,
  drawerTitle,
  drawerEyebrow,
  drawerSummary,
  pages = [],
  onPageDepthChange,
  children,
}: {
  title: string;
  label: string;
  summary: ReactNode;
  summaryDetail?: ReactNode;
  count: ReactNode;
  visibleCount: number;
  drawerClassName?: string;
  headerStats?: ReactNode;
  paused?: boolean;
  drawerTitle?: string;
  drawerEyebrow?: string;
  drawerSummary?: ReactNode;
  pages?: readonly SurfacePage[];
  onPageDepthChange?: (depth: number) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(visibleCount > 0);
  const launcherRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (visibleCount > 0) {
      setVisible(true);
      return;
    }
    setOpen(false);
    const timeout = window.setTimeout(() => {
      focusAfterSurfaceHides(launcherRef.current);
      setVisible(false);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [visibleCount]);
  const stackPages = useMemo<readonly SurfacePage[]>(
    () => [
      {
        id: `${label.toLowerCase()}-list`,
        title: drawerTitle ?? title,
        eyebrow: drawerEyebrow ?? label,
        hideTitle: !drawerTitle,
        headerSummary: drawerSummary ?? summary,
        headerContent: headerStats,
        children: <div className="work-surface-content">{children}</div>,
      },
      ...pages,
    ],
    [
      children,
      drawerEyebrow,
      drawerSummary,
      drawerTitle,
      headerStats,
      label,
      pages,
      summary,
      title,
    ],
  );
  if (!visible) return null;
  return (
    <>
      <article className="extension-surface" aria-label={title}>
        <AriaButton
          ref={launcherRef}
          type="button"
          className="surface-launcher"
          aria-haspopup="dialog"
          aria-expanded={open}
          onPress={() => {
            if (open) {
              setOpen(false);
              onPageDepthChange?.(0);
            } else setOpen(true);
          }}
        >
          <span className="surface-title">
            <span className="surface-title-line">
              <span className="eyebrow">{label}</span>
              <span className="surface-count">{count}</span>
            </span>
            {typeof summary === 'string' ? <strong>{summary}</strong> : summary}
            {summaryDetail}
          </span>
          <span className="surface-chevron" aria-hidden="true">
            ›
          </span>
        </AriaButton>
      </article>
      <SurfaceStack
        pages={stackPages}
        kind="work"
        className={drawerClassName}
        isOpen={open}
        paused={paused}
        onDepthChange={(depth) => {
          if (depth < 1) setOpen(false);
          onPageDepthChange?.(depth);
        }}
        onClose={() => {
          setOpen(false);
          onPageDepthChange?.(0);
        }}
      />
    </>
  );
}
