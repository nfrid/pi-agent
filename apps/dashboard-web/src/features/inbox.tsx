import type { BrowserSnapshot } from '@pi-dashboard/protocol';
import { NotificationList, PushButton, UsagePanel } from './notifications';

export function InboxView({
  snapshot,
  usageError,
}: {
  snapshot: BrowserSnapshot;
  usageError?: string;
}) {
  return (
    <section>
      <div className="section-heading page-heading">
        <div>
          <h1>Inbox</h1>
          <p className="muted">Notifications and account health.</p>
        </div>
      </div>
      <div className="inbox-preferences">
        <div>
          <strong>Notification delivery</strong>
          <p className="muted">Receive updates when runtimes need attention.</p>
        </div>
        <PushButton />
      </div>
      <NotificationList notifications={snapshot.unread} />
      <details className="secondary-panel">
        <summary>Usage and limits</summary>
        <UsagePanel usage={snapshot.usage} error={usageError} />
      </details>
    </section>
  );
}
