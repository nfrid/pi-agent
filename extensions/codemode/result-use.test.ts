import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ExtensionAPI,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';
import { expect, it } from 'vitest';
import { createBashDescriptionToolDefinition } from '../bash-description';
import { createWebSearchTool } from '../web/search-tool';
import { createWebResultStore } from '../web/storage';
import codemode from './index';

function example(index: number) {
  const section = readFileSync(
    resolve(__dirname, '../../docs/harness-behavior-evaluation.md'),
    'utf8',
  ).split('## Codemode result-use evaluation')[1];
  if (!section) throw new Error('Missing codemode result-use examples');
  const code = [...section.matchAll(/```js\n([\s\S]*?)```/g)][index]?.[1];
  if (!code) throw new Error(`Missing codemode example ${index}`);
  return code;
}

function sandbox(tool: ToolDefinition, respond: (args: unknown) => unknown) {
  let definition!: ToolDefinition;
  const entries: Array<{
    type: 'custom';
    customType: string;
    data: { set: Record<string, unknown>; delete: string[] };
  }> = [];
  codemode({
    registerTool: (registered: ToolDefinition) => {
      definition = registered;
    },
    appendEntry: (
      customType: string,
      data: (typeof entries)[number]['data'],
    ) => {
      entries.push({ type: 'custom', customType, data });
    },
    getSettings: () => ({ codemode: { mode: 'on' } }),
    getAllTools: () => [],
  } as unknown as ExtensionAPI);
  let call = 0;
  return {
    entries,
    definition,
    async execute(code: string) {
      const result = await definition.execute(
        'projection',
        { code },
        undefined,
        undefined,
        {
          tools: [tool],
          sessionManager: { getBranch: () => entries },
          executeTool: async (name: string, args: unknown) => {
            expect(name).toBe(tool.name);
            expect(Value.Check(tool.parameters, args)).toBe(true);
            const value = respond(args);
            return {
              toolCall: { id: `projection/${++call}`, name, arguments: args },
              isError: false,
              result: {
                content: [{ type: 'text', text: JSON.stringify(value) }],
                structuredContent: value,
              },
            };
          },
        } as never,
      );
      expect(result.isError).not.toBe(true);
      const last = result.content.at(-1);
      if (last?.type !== 'text') throw new Error('Missing JSON projection');
      return JSON.parse(last.text);
    },
  };
}

it('removes only codemode prompt guidelines while preserving its registered tool metadata', () => {
  const run = sandbox(createBashDescriptionToolDefinition(), () => ({}));
  expect(run.definition.name).toBe('codemode');
  expect(run.definition.promptGuidelines).toBeUndefined();
  expect(run.definition.promptSnippet).toBeDefined();
  expect(run.definition.defaultActive).toBe(false);
  expect(JSON.stringify(run.definition)).not.toContain('models');
});

it('runs the documented web projection with smaller output, visible errors, and retrievable originals', async () => {
  const fixture = {
    continuationAvailable: true,
    cacheFileWarning: 'Fixture cache unavailable',
    queries: [
      {
        query: 'Pi codemode',
        answer: 'Long answer not requested. '.repeat(2000),
        error: 'Fixture partial search timeout',
        sources: Array.from({ length: 5 }, (_, index) => ({
          title: `Source ${index}`,
          url: `https://example.invalid/${index}`,
          snippet: 'Unrequested snippet. '.repeat(200),
        })),
        pages: [],
      },
    ],
  };
  const tool = createWebSearchTool({
    resultStore: createWebResultStore(),
    operationGuard: () => () => {},
  });
  const run = sandbox(tool, () => fixture);
  const projected = await run.execute(example(0));
  expect(projected.queries).toEqual(
    fixture.queries.map(({ query, error, sources }) => ({
      query,
      error,
      sources: sources.map(({ title, url }) => ({ title, url })),
    })),
  );
  expect(projected.cacheFileWarning).toBe(fixture.cacheFileWarning);
  expect(run.entries.at(-1)?.data.set[projected.sourceKey]).toEqual(fixture);
  expect(
    await run.execute(
      `const original = load(${JSON.stringify(projected.sourceKey)}); return {answerLength: original.queries[0].answer.length, snippet: original.queries[0].sources[0].snippet};`,
    ),
  ).toEqual({
    answerLength: fixture.queries[0]?.answer.length,
    snippet: fixture.queries[0]?.sources[0]?.snippet,
  });
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(fixture)) / 10,
  );
});

it.each([
  false,
  true,
])('runs the documented bash projection retaining failed and original output (rejected=%s)', async (reject) => {
  const failure = 'Fixture failure diagnostic. '.repeat(100);
  const success = 'Fixture successful output. '.repeat(200);
  const run = sandbox(createBashDescriptionToolDefinition(), (args) => {
    const { command } = args as { command: string };
    if (command === 'git diff --check')
      return {
        exit_code: 0,
        output: success,
        truncated: true,
        full_output_path: '/fixture/full-check-output.txt',
        wall_time_seconds: 0,
      };
    if (reject) throw new Error(failure);
    return {
      exit_code: 1,
      output: failure,
      truncated: false,
      wall_time_seconds: 0,
    };
  });
  const projected = await run.execute(example(1));
  const retained = run.entries.at(-1)?.data.set[projected.sourceKey];
  expect(retained).toBeDefined();
  expect(JSON.stringify(projected)).toContain(failure);
  expect(JSON.stringify(retained)).toContain(success);
  expect(projected.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        exit_code: 0,
        truncated: true,
        full_output_path: '/fixture/full-check-output.txt',
      }),
    ]),
  );
  expect(
    await run.execute(`return load(${JSON.stringify(projected.sourceKey)});`),
  ).toEqual(retained);
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(retained)),
  );
});
