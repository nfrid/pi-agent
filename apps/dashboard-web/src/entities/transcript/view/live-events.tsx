import {
  commandMutationOptions,
  dashboardHttpClient,
} from '@pi-dashboard/client';
import { CONTINUE_ACTION_ID } from '@pi-dashboard/extension-contributions';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { runtimePauseStatus } from '../../../features/delegate/surface-model';
import { PauseIcon, PlayIcon } from '../../../features/pause-icon';
import { errorMessage } from '../../../shared/lib/error-message';

export function LivePauseEvent({ runtime }: { runtime?: RuntimeSnapshot }) {
  const pause = runtimePauseStatus(runtime);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  if (pause?.phase !== 'paused') return null;
  const continueRuntime = async () => {
    if (!runtime || pending || runtime.online === false) return;
    setPending(true);
    setError(undefined);
    try {
      await dashboardHttpClient.invokeAction(
        runtime.runtimeId,
        CONTINUE_ACTION_ID,
        {},
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className={`session-event event-pause live-pause-event${error ? ' event-failed' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="session-event-icon" aria-hidden="true">
        <PauseIcon className="pause-icon" />
      </span>
      <strong>{pause.label}</strong>
      <small>{error ?? (pending ? 'continuing…' : 'at a safe boundary')}</small>
      <AriaButton
        type="button"
        className="pause-continue-button"
        aria-label="Continue paused runtime"
        isDisabled={pending || runtime?.online === false}
        onPress={() => void continueRuntime()}
      >
        <PlayIcon className="play-icon" />
      </AriaButton>
    </div>
  );
}

export function LiveCompactionEvent({
  runtime,
}: {
  runtime?: RuntimeSnapshot;
}) {
  const command = useMutation(commandMutationOptions(dashboardHttpClient));
  const [error, setError] = useState<string>();
  if (runtime?.online === false || runtime?.liveState !== 'compacting')
    return null;
  const cancel = async () => {
    setError(undefined);
    try {
      await command.mutateAsync({
        runtimeId: runtime.runtimeId,
        command: { type: 'compact.cancel' },
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  return (
    <div
      className={`session-event event-compaction live-compaction-event${error ? ' event-failed' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="session-event-icon" aria-hidden="true">
        ◇
      </span>
      <strong>Compacting context…</strong>
      <small>{error ?? 'in progress'}</small>
      <AriaButton
        type="button"
        className="compaction-cancel-button"
        aria-label="Cancel context compaction"
        isDisabled={command.isPending}
        onPress={() => void cancel()}
      >
        ■
      </AriaButton>
    </div>
  );
}
