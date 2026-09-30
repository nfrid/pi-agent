import { createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';

export default defineExtension('codemode', (pi) => {
  createCodemodeExtension({ models: false })({
    ...pi,
    registerTool(tool) {
      // Shared instructions own selection policy; drop codemode's generic batching hint.
      const definition = { ...tool };
      delete definition.promptGuidelines;
      pi.registerTool(definition);
    },
  });
});
