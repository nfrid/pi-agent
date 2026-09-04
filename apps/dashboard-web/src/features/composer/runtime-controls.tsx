import {
  commandMutationOptions,
  dashboardHttpClient,
} from '@pi-dashboard/client';
import type { CodexServiceTier, RuntimeSnapshot } from '@pi-dashboard/protocol';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../shared/lib/error-message';
import { configuredModelOptions } from '../model-option';
import { AgentPicker } from './draft-pickers';

export function RuntimeAgentControl({
  runtime,
  runtimes,
}: {
  runtime: RuntimeSnapshot;
  runtimes: readonly RuntimeSnapshot[];
}) {
  const command = useMutation(commandMutationOptions(dashboardHttpClient));
  const [model, setModel] = useState(runtime.model);
  const [error, setError] = useState<string>();
  useEffect(() => setModel(runtime.model), [runtime.model]);
  const models = configuredModelOptions(runtimes, runtime);
  const levels =
    runtime.thinkingLevels ?? (model?.thinking ? [model.thinking] : []);
  const unavailable =
    runtime.online === false || runtime.liveState === 'stopping';
  const setRuntimeModel = async (next: { provider: string; model: string }) => {
    setError(undefined);
    try {
      await command.mutateAsync({
        runtimeId: runtime.runtimeId,
        command: { type: 'setModel', ...next },
      });
      setModel({
        ...next,
        ...(model?.thinking ? { thinking: model.thinking } : {}),
        ...(next.provider === 'openai-codex' && model?.serviceTier
          ? { serviceTier: model.serviceTier }
          : {}),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const setRuntimeServiceTier = async (
    serviceTier: CodexServiceTier | undefined,
  ) => {
    if (model?.provider !== 'openai-codex') return;
    setError(undefined);
    try {
      await command.mutateAsync({
        runtimeId: runtime.runtimeId,
        command: {
          type: 'setModel',
          provider: model.provider,
          model: model.model,
          serviceTier: serviceTier ?? null,
        },
      });
      const { serviceTier: _current, ...selection } = model;
      setModel({ ...selection, ...(serviceTier ? { serviceTier } : {}) });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const setRuntimeThinking = async (thinking: string) => {
    if (!model) return;
    setError(undefined);
    try {
      await command.mutateAsync({
        runtimeId: runtime.runtimeId,
        command: { type: 'setThinking', level: thinking },
      });
      setModel({ ...model, thinking });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  return (
    <AgentPicker
      model={model}
      models={models}
      levels={levels}
      disabled={unavailable}
      pending={command.isPending}
      error={error}
      onModelChange={(next) => void setRuntimeModel(next)}
      onThinkingChange={(thinking) => void setRuntimeThinking(thinking)}
      onServiceTierChange={(tier) => void setRuntimeServiceTier(tier)}
    />
  );
}
