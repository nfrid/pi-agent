import {
  commandMutationOptions,
  dashboardHttpClient,
} from '@pi-dashboard/client';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  configuredModelOptions,
  modelOptionValue,
  parseModelOptionValue,
} from '../model-option';
import { ComposerModelControl, ComposerThinkingControl } from './controls';

export function RuntimeModelControl({
  runtime,
  runtimes,
}: {
  runtime: RuntimeSnapshot;
  runtimes: readonly RuntimeSnapshot[];
}) {
  const command = useMutation(commandMutationOptions(dashboardHttpClient));
  const [modelValue, setModelValue] = useState(
    runtime.model
      ? modelOptionValue(runtime.model.provider, runtime.model.model)
      : '',
  );
  const [error, setError] = useState<string>();
  useEffect(
    () =>
      setModelValue(
        runtime.model
          ? modelOptionValue(runtime.model.provider, runtime.model.model)
          : '',
      ),
    [runtime.model],
  );
  const models = configuredModelOptions(runtimes, runtime);
  const unavailable =
    runtime.online === false || runtime.liveState === 'stopping';
  const setModel = async (value: string) => {
    const selected = parseModelOptionValue(value);
    if (!selected) return;
    setError(undefined);
    try {
      await command.mutateAsync({
        runtimeId: runtime.runtimeId,
        command: { type: 'setModel', ...selected },
      });
      setModelValue(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <ComposerModelControl
      models={models}
      value={modelValue}
      disabled={unavailable || command.isPending}
      onChange={(value) => void setModel(value)}
      error={error}
    />
  );
}

export function RuntimeThinkingControl({
  runtime,
}: {
  runtime: RuntimeSnapshot;
}) {
  const command = useMutation(commandMutationOptions(dashboardHttpClient));
  const [thinking, setThinking] = useState(runtime.model?.thinking ?? 'off');
  const [error, setError] = useState<string>();
  useEffect(
    () => setThinking(runtime.model?.thinking ?? 'off'),
    [runtime.model?.thinking],
  );
  const levels =
    runtime.thinkingLevels ??
    (runtime.model?.thinking ? [runtime.model.thinking] : []);
  const unavailable =
    runtime.online === false || runtime.liveState === 'stopping';
  const setLevel = async (level: string) => {
    setError(undefined);
    try {
      await command.mutateAsync({
        runtimeId: runtime.runtimeId,
        command: { type: 'setThinking', level },
      });
      setThinking(level);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <ComposerThinkingControl
      levels={levels}
      value={thinking}
      disabled={unavailable || command.isPending}
      onChange={(level) => void setLevel(level)}
      error={error}
    />
  );
}
