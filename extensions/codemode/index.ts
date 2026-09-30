import { createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';

export default defineExtension('codemode', (pi) => {
  createCodemodeExtension({ models: false })(pi);
});
