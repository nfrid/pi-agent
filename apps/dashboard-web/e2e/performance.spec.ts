import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  assertNoUnexpectedDashboardApiRequests,
  installDashboardBootstrap,
} from './dashboard-fixtures';

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
  jsDecodedBytes: number;
  jsTransferBytes: number;
  jsRequestCount: number;
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
    jsDecodedBytes: { median: number; p95: number };
    jsTransferBytes: { median: number; p95: number };
    jsRequestCount: { median: number; p95: number };
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
    jsDecodedBytes: summarize('jsDecodedBytes'),
    jsTransferBytes: summarize('jsTransferBytes'),
    jsRequestCount: summarize('jsRequestCount'),
  };
}

async function installMetrics(page: Page) {
  await page.addInitScript(() => {
    const state = {
      startedAt: performance.now(),
      actionStartedAt: undefined as number | undefined,
      longTasks: [] as Array<{ startTime: number; duration: number }>,
    };
    Object.assign(window, { __piDashboardPerformance: state });
    if ('PerformanceObserver' in window) {
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            state.longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
            });
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
          longTasks: Array<{ startTime: number; duration: number }>;
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
      }) as PerformanceResourceTiming[];
    const navigation = performance.getEntriesByType('navigation')[0];
    const navigationStart = navigation?.startTime ?? state.startedAt;
    const startedAt =
      measureAction && state.actionStartedAt !== undefined
        ? state.actionStartedAt
        : navigationStart;
    const actionLongTasks = state.longTasks.filter(
      (task) => task.startTime >= startedAt && task.startTime <= now,
    );
    return {
      durationMs: now - startedAt,
      longTaskCount: actionLongTasks.length,
      longTaskDurationMs: actionLongTasks.reduce(
        (total, task) => total + task.duration,
        0,
      ),
      domNodes: document.querySelectorAll('*').length,
      jsDecodedBytes: resources.reduce(
        (total, resource) => total + resource.decodedBodySize,
        0,
      ),
      jsTransferBytes: resources.reduce(
        (total, resource) => total + resource.transferSize,
        0,
      ),
      jsRequestCount: resources.length,
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
  // These legacy reads are still issued by the current shell; fixture them so
  // the strict catchall never falls through to a daemon.
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/session-threads', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/settings', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/threads*', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/sessions/*/delegate-history*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ version: 2, groups: [] }),
    }),
  );
  return { context, page };
}

async function coldPageSample(
  browser: Browser,
  pathname: '/' | '/sessions/baseline-session',
) {
  const state = await newPage(browser);
  try {
    await state.page.goto(pathname, { waitUntil: 'domcontentloaded' });
    if (pathname === '/') {
      await expect(
        state.page.getByRole('heading', { name: 'Pick a thread to continue' }),
      ).toBeVisible();
    } else {
      await expect(
        state.page.getByRole('heading', { name: 'Baseline session' }),
      ).toBeVisible();
      await expect(
        state.page.locator('.session-transcript-scroll'),
      ).toBeVisible();
    }
    assertNoUnexpectedDashboardApiRequests(state.page);
    return await metrics(state.page);
  } finally {
    await state.context.close();
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
    await page.locator('.outline-trigger').click();
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
    assertNoUnexpectedDashboardApiRequests(page);
    return await metrics(page, true);
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
    assertNoUnexpectedDashboardApiRequests(page);
    return await metrics(page, true);
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
        measurementClock:
          'navigation-start or action-start to driver-observed semantic UI readiness; not INP',
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
    await recordScenario('cold-home', browser, (currentBrowser) =>
      coldPageSample(currentBrowser, '/'),
    );
    await recordScenario('cold-direct-session', browser, (currentBrowser) =>
      coldPageSample(currentBrowser, '/sessions/baseline-session'),
    );
  });

  test('1000-entry transcript scroll and outline jump', async ({ browser }) => {
    await recordScenario(
      'large-history-scroll-and-outline',
      browser,
      historySample,
    );
  });

  test('20-tool activity expansion and one inspector', async ({ browser }) => {
    await recordScenario(
      '20-tool-activity-expansion-and-inspector',
      browser,
      activitySample,
    );
  });
});
