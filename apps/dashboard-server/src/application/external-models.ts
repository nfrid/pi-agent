import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export type ExternalModel = {
  provider: string;
  model: string;
  name: string;
  thinkingLevels: string[];
};

/** Restore the installed catalogue/auth availability without model inference. */
export async function externalModels(): Promise<ExternalModel[]> {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  return runtime.getAvailableSnapshot().map((model) => ({
    provider: model.provider,
    model: model.id,
    name: model.name,
    thinkingLevels: getSupportedThinkingLevels(model),
  }));
}
