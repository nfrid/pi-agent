import {
  dashboardHttpClient,
  sessionThreadLinksQueryOptions,
} from '@pi-dashboard/client';
import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { resolvedDraftPromotionIds } from './agent-thread-nav/model';
import { reconcileDraftPromotion, useDrafts } from './drafts';

/** Own promotion cleanup without coupling the navigation renderer to it. */
export function DraftPromotionLifecycle({
  snapshot,
}: {
  snapshot: BrowserSnapshot;
}) {
  const drafts = useDrafts();
  const linksQuery = useQuery(
    sessionThreadLinksQueryOptions(dashboardHttpClient),
  );
  const directLinks = useMemo(
    () => (linksQuery.isSuccess ? linksQuery.data : []),
    [linksQuery.isSuccess, linksQuery.data],
  );
  const resolvedPromotions = useMemo(
    () =>
      resolvedDraftPromotionIds(
        {
          sessions: snapshot.sessions,
          runtimes: snapshot.runtimes,
          runs: snapshot.runs,
        },
        directLinks,
        drafts,
      ),
    [directLinks, drafts, snapshot.sessions, snapshot.runtimes, snapshot.runs],
  );
  useEffect(() => {
    for (const draftId of resolvedPromotions) reconcileDraftPromotion(draftId);
  }, [resolvedPromotions]);
  return null;
}
