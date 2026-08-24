import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { SurfaceDrawer } from '../surface-drawer';

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
  drawerHeaderContent,
  drawerContent,
  hideDrawerHeader = false,
  onDrawerClose,
  children,
}: {
  title: string;
  label: string;
  summary: string;
  summaryDetail?: ReactNode;
  count: ReactNode;
  visibleCount: number;
  drawerClassName?: string;
  headerStats?: ReactNode;
  paused?: boolean;
  drawerTitle?: string;
  drawerEyebrow?: string;
  drawerSummary?: ReactNode;
  drawerHeaderContent?: ReactNode;
  drawerContent?: ReactNode;
  hideDrawerHeader?: boolean;
  onDrawerClose?: () => void;
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
          onPress={() => setOpen((current) => !current)}
        >
          <span className="surface-title">
            <span className="surface-title-line">
              <span className="eyebrow">{label}</span>
              <span className="surface-count">{count}</span>
            </span>
            <strong>{summary}</strong>
            {summaryDetail}
          </span>
          <span className="surface-chevron" aria-hidden="true">
            ›
          </span>
        </AriaButton>
      </article>
      <SurfaceDrawer
        title={drawerTitle ?? title}
        eyebrow={drawerEyebrow ?? label}
        hideTitle={!drawerTitle}
        hideHeader={hideDrawerHeader}
        headerSummary={drawerSummary ?? summary}
        className={drawerClassName}
        headerContent={drawerHeaderContent ?? headerStats}
        isOpen={open}
        paused={paused}
        onClose={() => {
          setOpen(false);
          onDrawerClose?.();
        }}
      >
        <div className="work-surface-content">{drawerContent ?? children}</div>
      </SurfaceDrawer>
    </>
  );
}
