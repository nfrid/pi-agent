import { dashboardHttpClient } from '@pi-dashboard/client';
import { useEffect, useState } from 'react';
import {
  isLocalInstalledDashboard,
  nativeStatus,
} from './native-notifications';

export function externalWebUrl(
  href: string,
  currentUrl: string,
): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, currentUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin === new URL(currentUrl).origin ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function ordinaryClick(
  event: Pick<
    MouseEvent,
    | 'defaultPrevented'
    | 'button'
    | 'metaKey'
    | 'ctrlKey'
    | 'shiftKey'
    | 'altKey'
  >,
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function ExternalLinkOpener() {
  const [available, setAvailable] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string>();

  useEffect(() => {
    if (!isLocalInstalledDashboard()) return;
    let disposed = false;
    void nativeStatus()
      .then((status) => {
        if (!disposed && status.available) setAvailable(true);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!available) return;
    const open = (event: MouseEvent) => {
      if (!ordinaryClick(event)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.hasAttribute('download')
      )
        return;
      const url = externalWebUrl(anchor.href, window.location.href);
      if (!url) return;
      event.preventDefault();
      setFailedUrl(undefined);
      void dashboardHttpClient
        .getTrpcClient()
        .then((client) => client.nativeOpenExternal.mutate({ url }))
        .then((result) => {
          if (!result.opened) setFailedUrl(url);
        })
        .catch(() => setFailedUrl(url));
    };
    document.addEventListener('click', open);
    return () => document.removeEventListener('click', open);
  }, [available]);

  if (!failedUrl) return null;
  return (
    <div className="notice" role="alert" aria-live="assertive">
      <p>Could not open this link in your default browser.</p>
      <a
        href={failedUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        Open link in Chrome
      </a>
      <button type="button" onClick={() => setFailedUrl(undefined)}>
        Dismiss
      </button>
    </div>
  );
}
