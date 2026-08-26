import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createLifecycleGuard } from '../shared/lifecycle-guard';
import { defineExtension } from '../shared/runtime/extension';
import { createFetchContentTool } from './fetch-tool';
import { createGetSearchContentTool } from './get-content-tool';
import { createWebSearchTool } from './search-tool';
import { createWebResultStore } from './storage';
import { throwIfAborted } from './utils';

export default defineExtension('web', (pi: ExtensionAPI) => {
  const resultStore = createWebResultStore();
  const lifecycle = createLifecycleGuard(
    {
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
});
