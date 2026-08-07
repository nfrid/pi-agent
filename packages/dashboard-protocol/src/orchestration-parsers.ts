import {
  type Checkout,
  CheckoutSchema,
  type Project,
  ProjectSchema,
  type Run,
  RunSchema,
  type Thread,
  ThreadSchema,
} from './orchestration-contracts.js';
import { parseSchema, tryParseSchema } from './utils.js';

export function parseProject(value: unknown): Project {
  return parseSchema(ProjectSchema, value, 'project');
}
export function tryParseProject(value: unknown): Project | undefined {
  return tryParseSchema(ProjectSchema, value);
}
export function parseCheckout(value: unknown): Checkout {
  return parseSchema(CheckoutSchema, value, 'checkout');
}
export function tryParseCheckout(value: unknown): Checkout | undefined {
  return tryParseSchema(CheckoutSchema, value);
}
export function parseThread(value: unknown): Thread {
  return parseSchema(ThreadSchema, value, 'thread');
}
export function tryParseThread(value: unknown): Thread | undefined {
  return tryParseSchema(ThreadSchema, value);
}
export function parseRun(value: unknown): Run {
  return parseSchema(RunSchema, value, 'run');
}
export function tryParseRun(value: unknown): Run | undefined {
  return tryParseSchema(RunSchema, value);
}
