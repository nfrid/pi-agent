import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLifecycleGuard } from '../shared/lifecycle-guard';
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
  const lifecycle = createLifecycleGuard(
    {
      onSessionStart: (ctx) => resultStore.restore(ctx),
      onSessionTree: (ctx) => resultStore.restore(ctx),
      onSessionShutdown: () => resultStore.clear(),
      boundaryError: 'Web operation crossed a session lifecycle boundary.',
    },
    throwIfAborted,
  );
  lifecycle.register(pi);

  pi.registerTool(
    createWebSearchTool({ pi, resultStore, operationGuard: lifecycle.guard }),
  );
  pi.registerTool(
    createFetchContentTool({
      pi,
      resultStore,
      operationGuard: lifecycle.guard,
    }),
  );
  pi.registerTool(createGetSearchContentTool(resultStore));
}
