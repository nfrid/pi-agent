import { dashboardHttpClient } from '@pi-dashboard/client';
import { useEffect, useRef, useState } from 'react';
import styles from './project-icon.module.css';

const PROJECT_ICON_CHANGED = 'pi-project-icon-changed';
const projectIconAssets = new Map<
  string,
  Promise<
    Awaited<ReturnType<typeof dashboardHttpClient.projectIcon>> | undefined
  >
>();

function projectIconAsset(projectId: string) {
  const cached = projectIconAssets.get(projectId);
  if (cached) return cached;
  const request = dashboardHttpClient.projectIcon(projectId).catch(() => {
    projectIconAssets.delete(projectId);
    return undefined;
  });
  projectIconAssets.set(projectId, request);
  return request;
}

export function refreshProjectIcon(projectId: string): void {
  projectIconAssets.delete(projectId);
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(PROJECT_ICON_CHANGED, { detail: projectId }),
  );
}

export function ProjectIcon({
  projectId,
  title,
  size = 'medium',
  onCustomChange,
}: {
  projectId: string;
  title: string;
  size?: 'tiny' | 'small' | 'medium' | 'large';
  onCustomChange?: (custom: boolean) => void;
}) {
  const [source, setSource] = useState<string>();
  const [custom, setCustom] = useState(false);
  const [revision, setRevision] = useState(0);
  const customChangeRef = useRef(onCustomChange);
  customChangeRef.current = onCustomChange;

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
    let active = true;
    if (revision > 0) setSource(undefined);
    let objectUrl: string | undefined;
    void projectIconAsset(projectId).then((asset) => {
      if (!active) return;
      if (!asset) {
        setCustom(false);
        customChangeRef.current?.(false);
        return;
      }
      objectUrl = URL.createObjectURL(asset.blob);
      const nextCustom = asset.source === 'custom';
      setCustom(nextCustom);
      customChangeRef.current?.(nextCustom);
      setSource(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, revision]);

  return (
    <span
      className={styles.icon}
      data-size={size}
      data-source={custom ? 'custom' : 'automatic'}
      aria-hidden="true"
    >
      {source ? (
        <img src={source} alt="" />
      ) : (
        title.trim().charAt(0).toUpperCase()
      )}
    </span>
  );
}
