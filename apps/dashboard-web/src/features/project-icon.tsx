import { dashboardHttpClient } from '@pi-dashboard/client';
import { useEffect, useState } from 'react';
import styles from './project-icon.module.css';

const PROJECT_ICON_CHANGED = 'pi-project-icon-changed';

export function refreshProjectIcon(projectId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(PROJECT_ICON_CHANGED, { detail: projectId }),
  );
}

export function ProjectIcon({
  projectId,
  title,
  size = 'medium',
}: {
  projectId: string;
  title: string;
  size?: 'small' | 'medium' | 'large';
}) {
  const [source, setSource] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const refresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail === projectId)
        setRevision((current) => current + 1);
    };
    window.addEventListener(PROJECT_ICON_CHANGED, refresh);
    return () => window.removeEventListener(PROJECT_ICON_CHANGED, refresh);
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    if (revision > 0) setSource(undefined);
    let objectUrl: string | undefined;
    void dashboardHttpClient
      .projectIcon(projectId, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, revision]);

  return (
    <span className={styles.icon} data-size={size} aria-hidden="true">
      {source ? (
        <img src={source} alt="" />
      ) : (
        title.trim().charAt(0).toUpperCase()
      )}
    </span>
  );
}
