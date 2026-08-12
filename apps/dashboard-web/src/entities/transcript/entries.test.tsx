import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  TranscriptModelItem,
  TranscriptStructuredResult,
} from '../../transcript';
import { StructuredDelegateResults, TranscriptEntry } from './entries';

describe('expanded transcript tool rows', () => {
  it('renders delegate structured output as a semantic document with raw JSON secondary', () => {
    const structuredResults: TranscriptStructuredResult[] = [
      {
        label: 'Audit',
        status: 'valid',
        value: {
          outcome: 'done',
          findings: [
            {
              filePath: 'src/App.tsx',
              lineCount: 42,
              notes: '**Review** with [dashboard](https://example.com).',
            },
          ],
        },
      },
    ];
    const item: TranscriptModelItem = {
      key: 'delegate-result',
      raw: {},
      entry: { kind: 'other', continuesGroup: true },
      event: {
        kind: 'delegate-result',
        label: 'Delegate finished · Audit',
        status: 'success',
        content: 'The audit completed successfully.',
        structuredResults,
      },
    };

    const markup = renderToStaticMarkup(
      <>
        <TranscriptEntry item={item} />
        <StructuredDelegateResults results={structuredResults} />
      </>,
    );

    expect(markup).toContain('aria-label="Structured delegate results"');
    expect(markup).not.toContain('aria-level=');
    expect(markup).not.toContain('role="heading"');
    expect(markup).toContain('>Payload</span>');
    expect(markup).toContain('object · 2 fields');
    expect(markup).toContain('>Outcome</strong>');
    expect(markup).toContain('>Findings</span>');
    expect(markup).toContain('array · 1 item');
    expect(markup).not.toContain('<dt>');
    expect(markup).toContain('src/App.tsx');
    expect(markup).toMatch(/class="markdown(?: |")/u);
    expect(markup).toContain('<strong>Review</strong>');
    expect(markup).toContain(
      '<a href="https://example.com" target="_blank" rel="noreferrer noopener">dashboard</a>',
    );
    expect(markup).toContain('Raw JSON');
    expect(markup).toContain('&quot;outcome&quot;: &quot;done&quot;');
    expect(markup).not.toContain('StructuredPayloadView');
  });

  it('renders cyclic delegate results without throwing and falls back to unavailable raw JSON', () => {
    const cycle: { items?: unknown[] } = {};
    const items: unknown[] = [cycle];
    cycle.items = items;
    const markup = renderToStaticMarkup(
      <StructuredDelegateResults
        results={[{ label: 'Cyclic audit', status: 'valid', value: cycle }]}
      />,
    );
    expect(markup).toContain('Nested content omitted after depth 4.');
    expect(markup).toContain('[unavailable payload]');
  });

  it('renders invalid and omitted delegate structured states explicitly', () => {
    const structuredResults: TranscriptStructuredResult[] = [
      {
        label: 'Invalid audit · Run 1',
        status: 'invalid',
        errors: ['/: expected result', '/: expected result'],
      },
      {
        label: 'Omitted audit · Run 1',
        status: 'valid',
        valueOmitted: true,
      },
    ];
    const markup = renderToStaticMarkup(
      <StructuredDelegateResults results={structuredResults} />,
    );

    expect(markup).toContain('/: expected result');
    expect(markup.match(/\/: expected result/g)).toHaveLength(2);
    expect(markup).toContain(
      'Structured result value unavailable in this bounded snapshot.',
    );
    expect(markup).not.toContain('Raw JSON');
  });

  it('shows an error marker for failed tool calls', () => {
    const item: TranscriptModelItem = {
      key: 'tool:error-call',
      raw: {},
      entry: {
        kind: 'tool',
        name: 'bash',
        args: { command: 'false' },
        status: 'error',
        isError: true,
      },
      tool: {
        kind: 'tool',
        key: 'tool:error-call',
        toolCallId: 'error-call',
        name: 'bash',
        arguments: { command: 'false' },
        result: 'Command failed',
        status: 'error',
        isError: true,
      },
    };

    const markup = renderToStaticMarkup(<TranscriptEntry item={item} />);

    expect(markup).toContain('tool-detail role-command step-failed');
    expect(markup).toContain(
      '<span class="activity-step-dot" aria-hidden="true">!</span>',
    );
  });
});
