import { dashboardHttpClient } from '@pi-dashboard/client';
import { useEffect, useState } from 'react';
import styles from './project-icon.module.css';

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

  useEffect(() => {
    const controller = new AbortController();
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
  }, [projectId]);

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
