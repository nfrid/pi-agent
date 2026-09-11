import { expect, type Page, test } from '@playwright/test';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcSseData,
} from './dashboard-fixtures';
import {
  buildWorkingScenario,
  installVisualStateScenario,
  VISUAL_TIMESTAMP,
} from './visual-state-fixtures';

async function openTurns(page: Page, count: number, repliesPerTurn = 1) {
  const base = buildWorkingScenario();
  if (!base.sessionSnapshot) throw new Error('Missing transcript fixture');
  const entries = Array.from({ length: count }, (_, index) => [
    {
      type: 'message',
      id: `prompt-${index}`,
      message: {
        role: 'user',
        timestamp: VISUAL_TIMESTAMP + index * 1000,
        content: [
          {
            type: 'text',
            text: `User prompt ${String(index + 1).padStart(3, '0')}: inspect the layout`,
          },
        ],
      },
    },
    ...Array.from({ length: repliesPerTurn }, (_, reply) => ({
      type: 'message',
      id: `reply-${index}-${reply}`,
      message: {
        role: 'assistant',
        timestamp: VISUAL_TIMESTAMP + index * 1000 + 500,
        content: [
          {
            type: 'text',
            text: `Assistant response ${index + 1}. Ordinary progress should not become an outline anchor.`,
          },
        ],
      },
    })),
  ]).flat();
  await installVisualStateScenario(page, {
    ...base,
    sessionSnapshot: { ...base.sessionSnapshot, entries },
  });
  await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeVisible();
  await expect(
    page.locator('.transcript-virtual-row, .transcript article').last(),
  ).toBeVisible();
}

test('dense outline stays bounded, never scrolls on hover and has no search surface @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await openTurns(page, 300);
  const rail = page.locator('.transcript-minimap');
  const scroll = page.locator('.session-transcript-scroll');
  await expect(rail).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open transcript outline', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('[data-transcript-outline-opener]')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const markers = rail.locator('.transcript-minimap-marker');
  expect(await markers.count()).toBeGreaterThan(1);
  expect(await markers.count()).toBeLessThan(300);
  await expect(
    page.locator('.transcript-minimap-marker[aria-current="location"]'),
  ).toHaveCount(1);
  const bounds = await markers.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }),
  );
  for (let index = 1; index < bounds.length; index++) {
    const current = bounds[index];
    const previous = bounds[index - 1];
    if (!current || !previous) throw new Error('Missing marker bounds');
    expect(current.top).toBeGreaterThanOrEqual(previous.bottom - 1);
  }
  const railBox = await rail.boundingBox();
  const scrollBox = await scroll.boundingBox();
  if (!railBox || !scrollBox) throw new Error('Missing outline geometry');
  expect(railBox.height).toBeLessThan(scrollBox.height);
  const before = await scroll.evaluate((element) => element.scrollTop);
  const tick = markers.first().locator('i');
  const restingWidth = (await tick.boundingBox())?.width;
  if (restingWidth === undefined) throw new Error('Missing resting tick');
  await markers.first().hover();
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBe(before);
  await expect
    .poll(async () => (await tick.boundingBox())?.width ?? 0)
    .toBeGreaterThan(restingWidth);
  await markers.first().click();
  await expect(
    page.locator('.message-user').filter({ hasText: 'User prompt 001' }),
  ).toBeVisible();
  await expect(markers.first()).toHaveAttribute('aria-current', 'location');
  await page.mouse.move(0, 0);
  await expect(scroll).toHaveScreenshot('quiet-outline-first-turn.png', {
    animations: 'disabled',
  });
});

test('23 desktop turns retain individual compact rail markers @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await openTurns(page, 23);
  const markers = page.locator('.transcript-minimap-marker');
  await expect(markers).toHaveCount(23);
  expect(
    await markers.evaluateAll((elements) =>
      elements.every((element) => element.dataset.clusterSize === '1'),
    ),
  ).toBe(true);
  const bounds = await markers.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect()),
  );
  const ticks = await markers.locator('i').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    }),
  );
  const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
  expect(new Set(ticks.map((tick) => tick.height)).size).toBe(1);
  for (const tick of ticks)
    expect(
      Math.abs(
        tick.top * devicePixelRatio - Math.round(tick.top * devicePixelRatio),
      ),
    ).toBeLessThan(0.01);
  for (let index = 1; index < bounds.length; index++) {
    const current = bounds[index];
    const previous = bounds[index - 1];
    if (!current || !previous) throw new Error('Missing marker bounds');
    expect(current.top - previous.top).toBe(8);
  }
});

test('partial history keeps the active outline turn by identity across prepend and jump @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  const base = buildWorkingScenario();
  const session = base.sessionSnapshot;
  if (!session) throw new Error('Missing transcript fixture');
  const oldTurns = Array.from({ length: 6 }, (_, turn) => [
    {
      type: 'message',
      id: `old-user-${turn}`,
      message: {
        role: 'user',
        content: `Old prompt ${turn}`,
      },
    },
    ...Array.from({ length: 15 }, (_, reply) => ({
      type: 'message',
      id: `old-reply-${turn}-${reply}`,
      message: {
        role: 'assistant',
        content: `Old response ${turn}-${reply}`,
      },
    })),
  ]).flat();
  const middleTurns = Array.from({ length: 6 }, (_, turn) => [
    {
      type: 'message',
      id: `middle-user-${turn}`,
      message: {
        role: 'user',
        content: `Middle prompt ${turn}`,
      },
    },
    ...Array.from({ length: 15 }, (_, reply) => ({
      type: 'message',
      id: `middle-reply-${turn}-${reply}`,
      message: {
        role: 'assistant',
        content: `Middle response ${turn}-${reply}`,
      },
    })),
  ]).flat();
  const outline = [
    ...Array.from({ length: 6 }, (_, turn) => ({
      id: `old-user-${turn}`,
      ordinal: turn * 16,
      kind: 'user' as const,
      label: `Old prompt ${turn}`,
    })),
    ...Array.from({ length: 6 }, (_, turn) => ({
      id: `middle-user-${turn}`,
      ordinal: 100 + turn * 16,
      kind: 'user' as const,
      label: `Middle prompt ${turn}`,
    })),
  ];
  const initial = {
    ...session,
    entries: middleTurns,
    outline,
    entriesComplete: false,
    history: {
      version: 1,
      start: 100,
      end: 196,
      hasOlder: true,
      nextBefore: 'older-page',
    },
    completeThroughCursor: false,
  };
  await installDashboardBootstrap(page, base.snapshot, {
    sessionSnapshot: initial,
  });
  let beforeRequest: string | undefined;
  await page.route('**/trpc/sessionSubscribe*', async (route) => {
    const response = {
      ...initial,
      serverId: base.snapshot.serverId,
      cursor: 1,
      active: { messages: [], tools: [], delegates: [], truncated: false },
    };
    await route.fulfill({
      contentType: 'text/event-stream',
      body: trpcSseData(
        { type: 'snapshot', sequence: 1, snapshot: response },
        'partial-outline-session',
      ),
    });
  });
  await page.route('**/trpc/sessionSnapshot*', async (route) => {
    const input = dashboardTrpcInput(route.request()) as { before?: string };
    beforeRequest = input.before;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          data: {
            ...initial,
            entries: [
              {
                type: 'session',
                id: 'working-session',
                cwd: '/workspace/dashboard',
              },
              ...oldTurns,
            ],
            history: { version: 1, start: 0, end: 100, hasOlder: false },
          },
        },
      }),
    });
  });

  await page.goto(base.route);
  const scroll = page.locator('.session-transcript-scroll');
  const markers = page.locator('.transcript-minimap-marker');
  await expect(markers).toHaveCount(12);
  await expect(
    markers.filter({ has: page.locator('i') }).last(),
  ).toHaveAttribute('aria-current', 'location');
  await expect(
    page.locator('.transcript-minimap-marker[aria-current="location"]'),
  ).toHaveAttribute('aria-label', 'Middle prompt 5');

  await markers.nth(3).click();
  await expect.poll(() => beforeRequest).toBe('older-page');
  await expect(
    page.locator('.transcript-minimap-marker[aria-current="location"]'),
  ).toHaveAttribute('aria-label', 'Old prompt 3');
  await expect(
    page.locator('.message-user').filter({ hasText: 'Old prompt 3' }),
  ).toBeVisible();

  await scroll.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(
    page.locator('.message-user').filter({ hasText: 'Old prompt 0' }),
  ).toBeVisible();
  await expect(
    page.locator('.transcript-minimap-marker[aria-current="location"]'),
  ).toHaveAttribute('aria-label', 'Old prompt 0');
});

test('minimap ticks stay uniformly device-pixel-sized at fractional DPR @desktop', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: `http://127.0.0.1:${process.env.PI_DASHBOARD_E2E_PORT ?? 43174}`,
    viewport: { width: 1440, height: 700 },
    deviceScaleFactor: 2.2,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  try {
    await openTurns(page, 23);
    const ticks = await page
      .locator('.transcript-minimap-marker i')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, height: rect.height };
        }),
      );
    const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
    const physicalHeights = ticks.map((tick) =>
      Math.round(tick.height * devicePixelRatio),
    );
    expect(new Set(physicalHeights)).toEqual(new Set([2]));
    for (const tick of ticks)
      expect(
        Math.abs(
          tick.top * devicePixelRatio - Math.round(tick.top * devicePixelRatio),
        ),
      ).toBeLessThan(0.05);
  } finally {
    await context.close();
  }
});

test('current turn remains correct when its user row is virtualized away @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await openTurns(page, 2, 50);
  const markers = page.locator('.transcript-minimap-marker');
  await expect(markers).toHaveCount(2);
  await expect(markers.last()).toHaveAttribute('aria-current', 'location');
  await page.locator('.session-transcript-scroll').evaluate((element) => {
    element.scrollTop = 1200;
  });
  await expect(
    page.locator('.message-user').filter({ hasText: 'User prompt 001' }),
  ).toHaveCount(0);
  await expect(markers.first()).toHaveAttribute('aria-current', 'location');
});

test('short desktop rail fits above a growing composer without overlapping targets @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 460 });
  await openTurns(page, 100);
  await page
    .getByRole('textbox', { name: 'Message Pi' })
    .fill(
      Array.from({ length: 7 }, (_, index) => `Draft line ${index}`).join('\n'),
    );
  const rail = page.locator('.transcript-minimap');
  await expect(rail).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rail = document.querySelector('.transcript-minimap');
        const scroll = document.querySelector('.session-transcript-scroll');
        const composer = document.querySelector('.composer');
        if (!rail || !scroll || !composer) return false;
        const rect = rail.getBoundingClientRect();
        const markers = Array.from(
          rail.querySelectorAll('.transcript-minimap-marker'),
        ).map((marker) => marker.getBoundingClientRect());
        return (
          markers.length > 0 &&
          rect.top >= scroll.getBoundingClientRect().top &&
          rect.bottom <= composer.getBoundingClientRect().top &&
          markers.every(
            (marker, index) =>
              marker.top >= rect.top &&
              marker.bottom <= rect.bottom &&
              (index === 0 ||
                marker.top >= (markers[index - 1]?.bottom ?? 0) - 1),
          )
        );
      }),
    )
    .toBe(true);
});
