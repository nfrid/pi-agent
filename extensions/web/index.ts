import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { createFetchContentTool } from './fetch-tool';
import { createGetSearchContentTool } from './get-content-tool';
import { createWebSearchTool } from './search-tool';
import { createWebResultStore } from './storage';
import { throwIfAborted } from './utils';

const registered = new WeakSet<object>();

export default function web(pi: ExtensionAPI): void {
  if (registered.has(pi)) return;
  registered.add(pi);

  const resultStore = createWebResultStore();
  let lifecycleGeneration = 0;
  const reset = (ctx: ExtensionContext) => {
    lifecycleGeneration++;
    resultStore.restore(ctx);
  };
  pi.on('session_start', (_event, ctx) => reset(ctx));
  pi.on('session_tree', (_event, ctx) => reset(ctx));
  pi.on('session_shutdown', () => {
    lifecycleGeneration++;
    resultStore.clear();
  });

  const operationGuard = (signal?: AbortSignal) => {
    const generation = lifecycleGeneration;
    return () => {
      throwIfAborted(signal);
      if (generation !== lifecycleGeneration)
        throw new Error('Web operation crossed a session lifecycle boundary.');
    };
  };

  pi.registerTool(createWebSearchTool({ pi, resultStore, operationGuard }));
  pi.registerTool(createFetchContentTool({ pi, resultStore, operationGuard }));
  pi.registerTool(createGetSearchContentTool(resultStore));
}
