import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { installDashboardBootstrap } from './dashboard-fixtures';

const WARMUP_RUNS = 1;
const MEASURED_RUNS = 5;
const REPORT_PATH =
  process.env.PI_DASHBOARD_PERF_REPORT ??
  path.join('/tmp', 'pi-dashboard-performance-report.json');

type BrowserMetrics = {
  durationMs: number;
  longTaskCount: number;
  longTaskDurationMs: number;
  domNodes: number;
  jsBytes: number;
};

type ScenarioReport = {
  scenario: string;
  samples: BrowserMetrics[];
  summary: {
    count: number;
    medianMs: number;
    p95Ms: number;
    longTasks: { median: number; p95: number };
    longTaskDurationMs: { median: number; p95: number };
    domNodes: { median: number; p95: number };
    jsBytes: { median: number; p95: number };
  };
};

const reports: ScenarioReport[] = [];

const session = {
  id: 'baseline-session',
  file: '/tmp/baseline-session.jsonl',
  cwd: '/tmp',
  title: 'Baseline session',
  updatedAt: 1,
};

const snapshot = {
  serverId: 'performance-baseline',
  revision: 1,
  cursor: 1,
  runtimes: [],
  workspaces: [],
  sessions: [session],
  unread: [],
};

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

function summary(samples: BrowserMetrics[]): ScenarioReport['summary'] {
  const values = (key: keyof BrowserMetrics) =>
    samples.map((sample) => Number(sample[key]));
  const summarize = (key: keyof BrowserMetrics) => ({
    median: percentile(values(key), 0.5),
    p95: percentile(values(key), 0.95),
  });
  return {
    count: samples.length,
    medianMs: summarize('durationMs').median,
    p95Ms: summarize('durationMs').p95,
    longTasks: summarize('longTaskCount'),
    longTaskDurationMs: summarize('longTaskDurationMs'),
    domNodes: summarize('domNodes'),
    jsBytes: summarize('jsBytes'),
  };
}

async function installMetrics(page: Page) {
  await page.addInitScript(() => {
    const state = {
      startedAt: performance.now(),
      actionStartedAt: undefined as number | undefined,
      longTasks: [] as number[],
    };
    Object.assign(window, { __piDashboardPerformance: state });
    if ('PerformanceObserver' in window) {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            state.longTasks.push(entry.duration);
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        // Long-task timing is optional in browsers without the entry type.
      }
    }
  });
}

async function metrics(page: Page, action = false): Promise<BrowserMetrics> {
  return page.evaluate((measureAction) => {
    const state = (
      window as unknown as {
        __piDashboardPerformance: {
          startedAt: number;
          actionStartedAt?: number;
          longTasks: number[];
        };
      }
    ).__piDashboardPerformance;
    const now = performance.now();
    const resources = performance
      .getEntriesByType('resource')
      .filter((entry) => {
        const resource = entry as PerformanceResourceTiming;
        return (
          resource.initiatorType === 'script' ||
          /\.m?js(?:[?#]|$)/u.test(resource.name)
        );
      })
      .map((entry) => {
        const resource = entry as PerformanceResourceTiming;
        return (
          resource.transferSize ||
          resource.encodedBodySize ||
          resource.decodedBodySize ||
          0
        );
      });
    const startedAt =
      measureAction && state.actionStartedAt !== undefined
        ? state.actionStartedAt
        : state.startedAt;
    return {
      durationMs: now - startedAt,
      longTaskCount: state.longTasks.length,
      longTaskDurationMs: state.longTasks.reduce(
        (total, duration) => total + duration,
        0,
      ),
      domNodes: document.querySelectorAll('*').length,
      jsBytes: resources.reduce((total, bytes) => total + bytes, 0),
    };
  }, action);
}

async function startAction(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = (
      window as unknown as {
        __piDashboardPerformance: { actionStartedAt?: number };
      }
    ).__piDashboardPerformance;
    state.actionStartedAt = performance.now();
  });
}

async function recordScenario(
  scenario: string,
  browser: Browser,
  sample: (browser: Browser) => Promise<BrowserMetrics>,
): Promise<void> {
  const samples: BrowserMetrics[] = [];
  for (let run = 0; run < WARMUP_RUNS + MEASURED_RUNS; run += 1) {
    const result = await sample(browser);
    if (run >= WARMUP_RUNS) samples.push(result);
  }
  reports.push({ scenario, samples, summary: summary(samples) });
}

async function newPage(
  browser: Browser,
  sessionSnapshot?: Record<string, unknown>,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  await installMetrics(page);
  await installDashboardBootstrap(page, snapshot, {
    strictApi: true,
    sessionSnapshot,
  });
  return { context, page };
}

async function coldSample(browser: Browser) {
  const home = await newPage(browser);
  try {
    await home.page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(
      home.page.getByRole('heading', { name: 'Pick a thread to continue' }),
    ).toBeVisible();
    const homeMetrics = await metrics(home.page);

    const direct = await newPage(browser);
    try {
      await direct.page.goto('/sessions/baseline-session', {
        waitUntil: 'domcontentloaded',
      });
      await expect(
        direct.page.getByRole('heading', { name: 'Baseline session' }),
      ).toBeVisible();
      await expect(
        direct.page.locator('.session-transcript-scroll'),
      ).toBeVisible();
      const directMetrics = await metrics(direct.page);
      return {
        ...directMetrics,
        durationMs: homeMetrics.durationMs + directMetrics.durationMs,
        longTaskCount: homeMetrics.longTaskCount + directMetrics.longTaskCount,
        longTaskDurationMs:
          homeMetrics.longTaskDurationMs + directMetrics.longTaskDurationMs,
        domNodes: directMetrics.domNodes,
        jsBytes: homeMetrics.jsBytes + directMetrics.jsBytes,
      };
    } finally {
      await direct.context.close();
    }
  } finally {
    await home.context.close();
  }
}

function historySnapshot() {
  const entries = [
    { type: 'session', id: session.id, cwd: session.cwd },
    ...Array.from({ length: 999 }, (_, index) => ({
      type: 'message',
      id: `history-${index}`,
      message: {
        role: index % 2 ? 'assistant' : 'user',
        content: `history message ${index}`,
      },
    })),
  ];
  return {
    entries,
    entriesComplete: true,
    outline: [0, 500, 998].map((index) => ({
      id: `history-${index}`,
      ordinal: index + 1,
      kind: index % 2 ? 'assistant' : 'user',
      label: `history message ${index}`,
    })),
  };
}

async function historySample(browser: Browser) {
  const pageState = await newPage(browser, historySnapshot());
  try {
    const { page } = pageState;
    await page.goto('/sessions/baseline-session', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('.transcript-virtualized')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Baseline session' }),
    ).toBeVisible();
    await startAction(page);
    const scroll = page.locator('.session-transcript-scroll');
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Open transcript outline' }).click();
    const outline = page.getByRole('dialog', { name: 'Transcript outline' });
    await expect(outline).toBeVisible();
    const target = outline
      .getByRole('button', { name: /Jump to history message/u })
      .nth(50);
    await expect(target).toHaveAttribute('aria-label');
    const targetLabel = await target.getAttribute('aria-label');
    if (!targetLabel) throw new Error('Outline target label is missing.');
    await target.click();
    await expect(outline).toHaveCount(0);
    await expect(
      page
        .getByRole('region', { name: 'Transcript' })
        .getByText(targetLabel.replace('Jump to ', ''), { exact: true }),
    ).toBeVisible();
    return metrics(page, true);
  } finally {
    await pageState.context.close();
  }
}

function activitySnapshot() {
  return {
    entries: [
      { type: 'session', id: session.id, cwd: session.cwd },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: 'tool',
        id: `activity-${index}`,
        tool: {
          toolCallId: `activity-${index}`,
          name: 'read',
          arguments: { path: `src/file-${index}.ts` },
          result: `tool result ${index} ${'detail '.repeat(12)}`,
          status: 'completed',
        },
      })),
    ],
    entriesComplete: true,
  };
}

async function activitySample(browser: Browser) {
  const pageState = await newPage(browser, activitySnapshot());
  try {
    const { page } = pageState;
    await page.goto('/sessions/baseline-session', {
      waitUntil: 'domcontentloaded',
    });
    const streamToggle = page.getByRole('button', {
      name: /Show all activity/u,
    });
    await expect(streamToggle).toBeVisible();
    await expect(page.locator('.tool-detail[open]')).toHaveCount(0);
    await startAction(page);
    await streamToggle.click();
    await expect(page.getByText('20 calls', { exact: true })).toBeVisible();
    await expect(page.locator('.tool-detail')).toHaveCount(20);
    await expect(page.locator('.tool-detail[open]')).toHaveCount(0);
    const firstTool = page.locator('.tool-detail').nth(10);
    await firstTool.locator(':scope > summary.tool-step').click();
    await expect(firstTool).toHaveAttribute('open', '');
    await expect(firstTool.locator('.tool-inspector')).toBeVisible();
    return metrics(page, true);
  } finally {
    await pageState.context.close();
  }
}

test.afterAll(() => {
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify(
      {
        buildId: 'dashboard-performance-baseline',
        timedRuns: MEASURED_RUNS,
        warmupRuns: WARMUP_RUNS,
        traces:
          process.env.PI_DASHBOARD_PERF_DIAGNOSTIC === '1'
            ? 'diagnostic'
            : 'off',
        pacedStreamSmoke:
          'not-run: existing paced stream setup is local to dashboard.spec.ts and is not a reusable fixture',
        scenarios: reports,
      },
      null,
      2,
    )}\n`,
  );
});

test.describe('production browser performance baseline', () => {
  test('cold home and direct-session initial load', async ({ browser }) => {
    await recordScenario('cold-home-and-direct-session', browser, coldSample);
  });

  test('1000-entry transcript scroll and outline jump', async ({ browser }) => {
    await recordScenario(
      'large-history-scroll-and-outline',
      browser,
      historySample,
    );
  });

  test('large activity expansion and one inspector', async ({ browser }) => {
    await recordScenario(
      'expanded-tool-activity-and-inspector',
      browser,
      activitySample,
    );
  });
});
