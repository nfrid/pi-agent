import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  dashboardTrpcInput,
  installDashboardBootstrap,
  trpcData,
  trpcSseData,
} from './dashboard-fixtures';

function transcriptScroll(page: Page) {
  return page.locator('.session-transcript-scroll');
}

async function transcriptGap(page: Page) {
  return transcriptScroll(page).evaluate(
    (element) =>
      element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

async function virtualTranscriptOverlap(page: Page) {
  return page.locator('.transcript-virtualizer').evaluate((element) => {
    const rows = Array.from(
      element.querySelectorAll<HTMLElement>(':scope > [data-index]'),
    )
      .map((row) => row.getBoundingClientRect())
      .sort((left, right) => left.top - right.top);
    return rows.reduce(
      (overlap, row, index) =>
        Math.max(overlap, (rows[index - 1]?.bottom ?? row.top) - row.top),
      0,
    );
  });
}

async function scrollTranscript(page: Page, top: number) {
  await transcriptScroll(page).evaluate((element, nextTop) => {
    if (nextTop < element.scrollTop)
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    element.scrollTop = nextTop;
    element.dispatchEvent(new Event('scroll'));
  }, top);
}

async function swipe(
  target: Locator,
  { dx, dy = 0 }: { dx: number; dy?: number },
) {
  await target.evaluate(
    (element, movement) => {
      const point = (x: number, y: number) =>
        new Touch({
          identifier: 1,
          target: element,
          clientX: x,
          clientY: y,
        });
      const dispatch = (
        type: 'touchstart' | 'touchmove' | 'touchend',
        touches: Touch[],
        changedTouches: Touch[],
      ) =>
        element.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches,
            changedTouches,
          }),
        );
      const start = point(24, 180);
      const end = point(24 + movement.dx, 180 + movement.dy);
      dispatch('touchstart', [start], [start]);
      dispatch('touchmove', [end], [end]);
      dispatch('touchend', [], [end]);
    },
    { dx, dy },
  );
}

async function sharedDrawerMotion(drawer: Locator) {
  return drawer.evaluate((element) => {
    const style = getComputedStyle(element);
    const transforms = element
      .getAnimations()
      .flatMap((animation) => animation.effect?.getKeyframes() ?? [])
      .map((keyframe) => String(keyframe.transform ?? ''));
    return {
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      animationTimingFunction: style.animationTimingFunction,
      transforms,
    };
  });
}

test('mobile transcript image gallery loads, navigates, and swipes away', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const session = {
    id: 'session-images',
    file: '',
    cwd: '/tmp',
    title: 'Image gallery',
    updatedAt: 1,
  };
  await installDashboardBootstrap(
    page,
    {
      serverId: 'server-images',
      revision: 1,
      cursor: 1,
      runtimes: [
        {
          runtimeId: 'runtime-images',
          ownership: 'external',
          pid: 1,
          cwd: session.cwd,
          liveState: 'idle',
          online: true,
          session: { id: session.id, title: session.title, entries: [] },
        },
      ],
      workspaces: [],
      sessions: [session],
      unread: [],
    },
    {
      sessionSnapshot: {
        entries: [
          {
            type: 'message',
            id: 'entry-images',
            message: {
              role: 'user',
              timestamp: 12345,
              content: [
                { type: 'image', mimeType: 'image/png', omitted: true },
                { type: 'image', mimeType: 'image/png', omitted: true },
              ],
            },
          },
        ],
      },
    },
  );
  let releaseThumbnails!: () => void;
  const thumbnailsReady = new Promise<void>((resolve) => {
    releaseThumbnails = resolve;
  });
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  let thumbnailRequests = 0;
  let fullRequests = 0;
  await page.route(
    '**/api/sessions/session-images/images/**',
    async (route) => {
      const search = new URL(route.request().url()).searchParams;
      expect(search.get('timestamp')).toBe('12345');
      if (search.has('variant')) {
        thumbnailRequests += 1;
        await thumbnailsReady;
      } else {
        fullRequests += 1;
      }
      await route.fulfill({ contentType: 'image/png', body: image });
    },
  );

  await page.goto('/sessions/session-images');
  await expect(
    page.getByRole('button', { name: 'Loading attachment 1' }),
  ).toBeVisible();
  releaseThumbnails();
  const first = page.getByRole('button', {
    name: 'Open attached image 1',
  });
  await expect(first).toBeEnabled();
  await page.waitForTimeout(300);
  expect(thumbnailRequests).toBe(2);
  await first.click();

  const dialog = page.getByRole('dialog', {
    name: 'Attached image 1 of 2',
  });
  await expect(dialog).toBeVisible();
  await expect.poll(() => fullRequests).toBe(1);
  await page.getByRole('button', { name: 'Close image viewer' }).click();
  await expect(dialog).toBeHidden();
  await first.click();
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(100);
  expect(fullRequests).toBe(1);
  await expect(
    page.getByRole('button', { name: 'Previous attached image' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Next attached image' }),
  ).toBeVisible();
  const closeStyle = await page
    .getByRole('button', { name: 'Close image viewer' })
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width: style.width,
        height: style.height,
        borderRadius: style.borderRadius,
      };
    });
  expect(closeStyle).toEqual({
    width: '44px',
    height: '44px',
    borderRadius: '50%',
  });

  await dialog.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 1,
        pointerType: 'touch',
        clientX: 220,
        clientY: 200,
      }),
    );
    element.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 1,
        pointerType: 'touch',
        clientX: 100,
        clientY: 205,
      }),
    );
  });
  const secondDialog = page.getByRole('dialog', {
    name: 'Attached image 2 of 2',
  });
  await expect(secondDialog).toBeVisible();
  await expect.poll(() => fullRequests).toBe(2);
  await page.getByRole('button', { name: 'Previous attached image' }).click();
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Next attached image' }).click();
  await expect(secondDialog).toBeVisible();
  expect(fullRequests).toBe(2);

  await secondDialog.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 2,
        pointerType: 'touch',
        clientX: 160,
        clientY: 150,
      }),
    );
    element.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 2,
        pointerType: 'touch',
        clientX: 165,
        clientY: 250,
      }),
    );
  });
  await expect(secondDialog).toBeHidden();
});

test('mobile dashboard renders and supports project-scoped new chat', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/projects/p/draft-defaults', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        selection: {
          provider: 'openai-codex',
          model: 'careful',
          thinking: 'high',
          serviceTier: 'fast',
        },
        source: 'project',
      }),
    }),
  );
  await page.route('**/trpc/composerCommands', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        commands: [
          {
            name: 'review',
            description: 'Review changes',
            source: 'prompt',
          },
          {
            name: 'skill:browser',
            description: 'Automate a browser',
            source: 'skill',
          },
        ],
      }),
    }),
  );
  await page.route('**/api/projects/p/git-context', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        branch: 'main',
        dirty: true,
        changedFileCount: 2,
        localBranches: [
          'main',
          'develop/this-is-a-deliberately-long-worktree-branch-name',
        ],
      }),
    }),
  );
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-mobile',
    revision: 1,
    cursor: 1,
    runtimes: [
      {
        runtimeId: 'ghost',
        ownership: 'external',
        projectId: 'p',
        pid: 1,
        cwd: '/Users/example/this-is-a-deliberately-long-workspace-path/with-more-segments/project',
        liveState: 'idle',
        online: false,
        lastSeenAt: 20,
        model: {
          provider: 'openai-codex',
          model: 'careful',
          thinking: 'high',
          serviceTier: 'ultrafast',
          supportsImages: true,
        },
        modelCatalog: [
          { provider: 'openai-codex', model: 'fast', name: 'Fast' },
          {
            provider: 'openai-codex',
            model: 'careful',
            name: 'Careful',
            supportsImages: true,
          },
        ],
        thinkingLevels: ['off', 'medium', 'high'],
        session: {
          id: 'ghost-session',
          title: 'A deliberately long session title that must wrap safely',
          entries: [],
        },
      },
    ],
    projects: [
      {
        id: 'p',
        title: 'Demo project',
        rootPath:
          '/Users/example/this-is-a-deliberately-long-workspace-path/with-more-segments/project',
        defaultModel: {
          provider: 'openai-codex',
          model: 'careful',
          thinking: 'high',
          serviceTier: 'fast',
        },
        status: 'active',
      },
    ],
    checkouts: [
      {
        id: 'checkout-main',
        projectId: 'p',
        kind: 'main',
        path: '/Users/example/this-is-a-deliberately-long-workspace-path/with-more-segments/project',
        branch: 'main',
        status: 'dirty',
        changedFileCount: 2,
        updatedAt: 1,
      },
    ],
    sessions: [],
    unread: [],
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Pick a thread to continue' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'No runtimes are connected. Offline and failed threads remain in the project nav for diagnosis.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open agent list' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await expect(page.getByText('Pi Dashboard', { exact: true })).toBeVisible();
  await expect(page.getByText('Agents', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'A deliberately long session title that must wrap safely offline',
    }),
  ).toBeVisible();
  const agentNav = page.getByRole('complementary', {
    name: 'Agents and threads',
  });
  const mobileThreadRow = agentNav.locator('.agent-thread-row').first();
  await expect(mobileThreadRow).toContainText('Demo');
  await expect(mobileThreadRow).toContainText('offline');
  await expect(
    mobileThreadRow.getByRole('img', { name: 'Ultrafast' }),
  ).toBeVisible();
  await expect(mobileThreadRow).not.toContainText('/Users/example');
  await expect(
    agentNav.getByRole('button', { name: /New thread/ }),
  ).toBeVisible();
  await expect(agentNav.getByRole('heading', { name: 'History' })).toHaveCount(
    0,
  );
  await expect(
    agentNav.getByRole('button', {
      name: 'A deliberately long session title that must wrap safely offline',
    }),
  ).toBeVisible();
  const threadSearch = agentNav.getByPlaceholder('Search threads');
  await threadSearch.fill('deliberately long');
  await threadSearch.press('ArrowDown');
  await expect(agentNav.locator('[data-search-active=""]')).toContainText(
    'A deliberately long session title that must wrap safely',
  );
  await threadSearch.press('Enter');
  await expect(page).toHaveURL(/\/sessions\/ghost-session$/u);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const reopenedAgentNav = page.getByRole('complementary', {
    name: 'Agents and threads',
  });
  await reopenedAgentNav
    .getByPlaceholder('Search threads')
    .fill('deliberately long');
  await expect(
    reopenedAgentNav.getByRole('button', {
      name: 'A deliberately long session title that must wrap safely offline',
    }),
  ).toBeVisible();
  await reopenedAgentNav
    .getByRole('button', { name: 'Clear thread search' })
    .click();
  await expect(
    agentNav.getByRole('button', {
      name: 'A deliberately long session title that must wrap safely offline',
    }),
  ).toBeVisible();
  await page.locator('.agent-nav-backdrop').click();
  await expect(page.locator('.agent-nav-backdrop')).toHaveCount(0);
  const paletteTrigger = page.getByRole('button', {
    name: 'Open command palette',
  });
  await paletteTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await expect(page.getByRole('option', { name: /Dashboard/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /New thread/ })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Actions' })).toBeVisible();
  await page
    .getByRole('combobox', {
      name: 'Search commands, threads, and projects',
    })
    .fill('does-not-exist');
  await expect(
    page.getByText('No results for "does-not-exist".'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('combobox', {
      name: 'Search commands, threads, and projects',
    }),
  ).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Open command palette' }),
  ).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Meta+k');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toHaveCount(0);
  await page.keyboard.press('Meta+k');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Meta+k');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toHaveCount(0);
  await paletteTrigger.click();
  await page.getByRole('option', { name: /New thread/ }).click();
  const paletteProjectChooser = page.getByRole('dialog', {
    name: 'Choose a project',
  });
  await expect(paletteProjectChooser).toBeVisible();
  await paletteProjectChooser
    .getByRole('option', { name: /Demo project/ })
    .click();
  await expect(page).toHaveURL(/\/drafts\/[^/]+$/u);
  await expect(page.getByRole('heading', { name: 'New thread' })).toBeVisible();
  await expect(page.locator('.session-status.status-draft')).toContainText(
    'draft',
  );
  await expect(page.getByRole('button', { name: 'Delete draft' })).toHaveCount(
    0,
  );
  const draftComposer = page.getByRole('textbox', { name: 'Message Pi' });
  await expect(draftComposer).toBeVisible();
  await draftComposer.fill('/rev');
  await expect(page.getByRole('option', { name: /\/review/ })).toBeVisible();
  await draftComposer.press('Tab');
  await expect(draftComposer).toContainText('/review');
  expect(
    await draftComposer.evaluate(() => window.getSelection()?.anchorOffset),
  ).toBe('/review'.length);
  await draftComposer.fill('');
  const locationControl = page.getByRole('button', {
    name: 'Checkout location',
  });
  await expect(locationControl).toContainText('Current checkout · main');
  await locationControl.click();
  const locationSheet = page.getByRole('dialog', {
    name: 'Checkout location',
  });
  await expect(
    locationSheet.getByRole('button', { name: 'Done' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close Checkout location' }).click();
  await expect(locationSheet).toHaveCount(0);
  await locationControl.click();
  const locationSheetBox = await locationSheet.boundingBox();
  expect(locationSheetBox).not.toBeNull();
  expect((locationSheetBox?.y ?? 0) + (locationSheetBox?.height ?? 0)).toBe(
    720,
  );
  await locationSheet.getByRole('button', { name: /Choose a branch/ }).click();
  await locationSheet
    .getByRole('textbox', { name: 'Search local branches' })
    .fill('dev');
  await locationSheet
    .getByRole('button', {
      name: 'develop/this-is-a-deliberately-long-worktree-branch-name',
    })
    .click();
  await expect(locationSheet).toHaveCount(0);
  await expect(locationControl).toContainText(
    'New wt · develop/this-is-a-deliberately-long-worktree-branch-name',
  );
  const compactAgentControl = page.getByRole('button', {
    name: 'Agent and thinking',
  });
  const [longLocationBox, compactAgentBox] = await Promise.all([
    locationControl.boundingBox(),
    compactAgentControl.boundingBox(),
  ]);
  expect(longLocationBox).not.toBeNull();
  expect(compactAgentBox).not.toBeNull();
  expect(
    Math.abs((longLocationBox?.y ?? 0) - (compactAgentBox?.y ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(longLocationBox?.x ?? 0).toBeLessThan(compactAgentBox?.x ?? 0);
  expect(
    await locationControl
      .locator('span')
      .evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  await locationControl.click();
  await page
    .getByRole('dialog', { name: 'Checkout location' })
    .getByRole('button', { name: /Current checkout/ })
    .click();
  await expect(locationControl).toContainText('Current checkout · main');

  const agentControl = page.getByRole('button', {
    name: 'Agent and thinking',
  });
  await expect(agentControl).toContainText('Careful· high');
  const footerStyle = await agentControl.evaluate((button) => {
    const model = button.querySelector('.draft-agent-model');
    const thinking = button.querySelector('.draft-agent-thinking');
    return {
      thinkingMargin: thinking ? getComputedStyle(thinking).marginLeft : '',
      modelColor: model ? getComputedStyle(model).color : '',
      thinkingColor: thinking ? getComputedStyle(thinking).color : '',
    };
  });
  expect(footerStyle.thinkingMargin).toBe('3px');
  expect(footerStyle.modelColor).not.toBe(footerStyle.thinkingColor);
  expect(
    await locationControl
      .locator('svg')
      .evaluate((icon) => getComputedStyle(icon).marginRight),
  ).toBe('4px');
  await agentControl.click();
  const agentSheet = page.getByRole('dialog', {
    name: 'Agent and thinking',
  });
  const speed = agentSheet.getByRole('group', { name: 'Codex speed' });
  await expect(speed).toBeVisible();
  await expect(speed.locator('.service-tier-icon')).toHaveCount(2);
  await speed.locator('button[data-service-tier="fast"]').click();
  await agentSheet
    .locator('.draft-picker-option')
    .filter({ hasText: 'Fast' })
    .click();
  await expect(agentSheet).toBeVisible();
  await agentSheet.getByRole('button', { name: 'medium' }).click();
  await expect(agentSheet).toBeVisible();
  await page.getByRole('button', { name: 'Close Agent and thinking' }).click();
  await expect(agentSheet).toHaveCount(0);
  await expect(agentControl).toContainText('Fast· medium');
  await expect(agentControl.getByRole('img', { name: 'Fast' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const drafts = JSON.parse(
          localStorage.getItem('pi-dashboard-drafts:v1') ?? '[]',
        ) as Array<{ location?: unknown; model?: unknown }>;
        return { location: drafts[0]?.location, model: drafts[0]?.model };
      }),
    )
    .toEqual({
      location: { kind: 'current' },
      model: {
        provider: 'openai-codex',
        model: 'fast',
        thinking: 'medium',
        serviceTier: 'fast',
      },
    });
  const emptyState = page.getByText('New conversation');
  const transcript = page.getByRole('region', { name: 'Transcript' });
  const [emptyBox, transcriptBox] = await Promise.all([
    emptyState.boundingBox(),
    transcript.boundingBox(),
  ]);
  expect(emptyBox).not.toBeNull();
  expect(transcriptBox).not.toBeNull();
  expect(
    Math.abs(
      (emptyBox?.y ?? 0) +
        (emptyBox?.height ?? 0) / 2 -
        ((transcriptBox?.y ?? 0) + (transcriptBox?.height ?? 0) / 2),
    ),
  ).toBeLessThan(40);
  expect(
    await page
      .locator('body')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const draftUrl = page.url();
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const draftNav = page.getByRole('complementary', {
    name: 'Agents and threads',
  });
  await expect(draftNav).toBeVisible();
  await draftNav.evaluate((element) => {
    element.setAttribute('data-route-continuity', 'draft-nav');
  });
  await draftNav
    .getByRole('button', {
      name: 'A deliberately long session title that must wrap safely offline',
    })
    .click();
  await expect(page).toHaveURL(/\/sessions\/ghost-session$/u);
  await expect(page.locator('[data-route-continuity="draft-nav"]')).toHaveCount(
    1,
  );
  await page.goBack();
  await expect(page).toHaveURL(draftUrl);
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const draftRow = draftNav.locator('.agent-thread-row.selected');
  await draftRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete draft' }).click();
  await expect(page).toHaveURL(draftUrl);
  await expect(page.getByText('Draft deleted')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('pi-dashboard-drafts:v1') ?? '[]'),
      ),
    )
    .toEqual([]);
});

test('mobile project picker dismisses without closing the agent drawer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route('**/api/threads*', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/session-threads', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-mobile-picker',
    revision: 1,
    cursor: 1,
    runtimes: [],
    projects: [
      { id: 'one', title: 'One', rootPath: '/work/one', status: 'active' },
      { id: 'two', title: 'Two', rootPath: '/work/two', status: 'active' },
    ],
    sessions: [],
    unread: [],
  } as never);

  await page.goto('/');
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const nav = page.getByRole('complementary', {
    name: 'Agents and threads',
  });
  const newThread = nav.getByRole('button', { name: /New thread/ });
  await newThread.click();
  const chooser = page.getByRole('dialog', { name: 'Choose a project' });
  await expect(chooser).toBeVisible();
  const chooserSearch = chooser.getByRole('combobox', {
    name: 'Search projects',
  });
  await chooserSearch.press('Control+j');
  await expect(chooser.getByRole('option', { selected: true })).toContainText(
    'Two',
  );
  await chooserSearch.press('Control+k');
  await expect(chooser.getByRole('option', { selected: true })).toContainText(
    'One',
  );
  await chooserSearch.fill('Tw');
  const clearProjectSearch = chooser.getByRole('button', {
    name: 'Clear project search',
  });
  await expect(clearProjectSearch).toHaveCount(1);
  await clearProjectSearch.click();
  await expect(chooserSearch).toHaveValue('');
  await expect(chooserSearch).toBeFocused();
  await chooserSearch.fill('Tw');
  await chooserSearch.press('Escape');
  await expect(chooserSearch).toHaveValue('');
  await expect(chooser).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(chooser).toHaveCount(0);
  await expect(newThread).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Close agent list' }),
  ).toBeVisible();

  await newThread.click();
  await chooser.getByRole('button', { name: 'Close Choose a project' }).click();
  await expect(chooser).toHaveCount(0);
  await expect(newThread).toBeFocused();
  await newThread.click();
  await page
    .locator('.surface-drawer-layer')
    .click({ position: { x: 2, y: 2 } });
  await expect(chooser).toHaveCount(0);
  await expect(newThread).toBeFocused();

  await newThread.click();
  await chooser.getByRole('option', { name: /Two/ }).click();
  await expect(page).toHaveURL(/\/drafts\/[^/]+$/u);
  await expect(page.locator('.agent-nav-backdrop')).toHaveCount(0);
});

test('draft composer completes slash commands before a runtime starts', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'pi-dashboard-drafts:v1',
      JSON.stringify([
        {
          id: 'draft-autocomplete',
          projectId: 'project-autocomplete',
          createdAt: 1,
          updatedAt: 1,
          isolation: 'main',
          location: { kind: 'current' },
        },
      ]),
    );
  });
  await page.route('**/trpc/composerCommands', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        commands: [
          {
            name: 'review',
            description: 'Review changes',
            source: 'prompt',
          },
        ],
      }),
    }),
  );
  let submittedPrompt: string | undefined;
  await page.route(
    '**/api/projects/project-autocomplete/threads',
    async (route) => {
      submittedPrompt = (route.request().postDataJSON() as { prompt: string })
        .prompt;
      await route.fulfill({
        contentType: 'application/json',
        status: 202,
        body: JSON.stringify({
          thread: { id: 'thread-autocomplete' },
          run: { id: 'run-autocomplete' },
          receipt: { idempotencyKey: 'draft-promote-draft-autocomplete' },
        }),
      });
    },
  );
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-draft-autocomplete',
    revision: 1,
    cursor: 1,
    runtimes: [],
    projects: [
      {
        id: 'project-autocomplete',
        title: 'Autocomplete project',
        rootPath: '/tmp/autocomplete-project',
        defaultIsolation: 'main',
        maxParallelRuns: 1,
        activeRunCount: 0,
        status: 'active',
        updatedAt: 1,
      },
    ],
    checkouts: [
      {
        id: 'checkout-autocomplete',
        projectId: 'project-autocomplete',
        kind: 'main',
        path: '/tmp/autocomplete-project',
        status: 'clean',
        updatedAt: 1,
      },
    ],
    sessions: [],
    unread: [],
  });

  await page.goto('/drafts/draft-autocomplete');
  const editor = page.getByRole('textbox', { name: 'Message Pi' });
  await expect(editor).toBeVisible();
  await editor.fill('/rev');
  await expect(page.getByRole('option', { name: /\/review/ })).toBeVisible();
  await editor.press('Tab');
  await expect(editor).toContainText('/review');
  expect(await editor.evaluate(() => window.getSelection()?.anchorOffset)).toBe(
    '/review'.length,
  );
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => submittedPrompt).toBe('/review');
});

test('promoted draft is replaced by its started thread in the sidebar @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem(
      'pi-dashboard-drafts:v1',
      JSON.stringify([
        {
          id: 'draft-promoted',
          projectId: 'project-1',
          createdAt: 10,
          updatedAt: 20,
          isolation: 'worktree',
          title: 'Promoted draft',
          promotedThreadId: 'thread-1',
        },
      ]),
    );
  });
  await page.route('**/api/threads*', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/session-threads', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-promoted-draft',
    revision: 1,
    cursor: 1,
    projects: [
      {
        id: 'project-1',
        title: 'Project One',
        rootPath: '/work/one',
        status: 'active',
      },
    ],
    runs: [
      {
        id: 'run-1',
        threadId: 'thread-1',
        checkoutId: 'checkout-1',
        attempt: 1,
        mode: 'new',
        runtimeProvider: 'extension-bridge',
        runtimeId: 'runtime-1',
        initialPrompt: 'Start it',
        status: 'running',
        createdAt: 20,
      },
    ],
    runtimes: [],
    sessions: [
      {
        id: 'session-1',
        projectId: 'project-1',
        activeRuntimeId: 'runtime-1',
        cwd: '/work/one',
        title: 'Started thread',
        startedAt: 21,
        updatedAt: 21,
      },
    ],
    unread: [],
  } as never);

  await page.goto('/sessions/session-1');
  const nav = page.getByRole('complementary', {
    name: 'Agents and threads',
  });
  await expect(nav.locator('.agent-thread-row')).toHaveCount(1);
  await expect(
    nav.getByRole('button', { name: /Started thread ready/ }),
  ).toBeVisible();
  await expect(nav.getByText('Promoted draft')).toHaveCount(0);
});

test('sidebar New thread handles one and zero project fallbacks @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const routeSidebarData = async (target: Page) => {
    await target.route('**/api/threads*', async (route) =>
      route.fulfill({ contentType: 'application/json', body: '[]' }),
    );
    await target.route('**/api/session-threads', async (route) =>
      route.fulfill({ contentType: 'application/json', body: '[]' }),
    );
  };
  await routeSidebarData(page);
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-one-project',
    revision: 1,
    cursor: 1,
    runtimes: [],
    projects: [
      { id: 'only', title: 'Only', rootPath: '/work/only', status: 'active' },
    ],
    sessions: [],
    unread: [],
  } as never);
  await page.goto('/');
  const nav = page.getByRole('complementary', {
    name: 'Agents and threads',
  });
  await nav.getByRole('button', { name: /New thread/ }).click();
  await expect(page).toHaveURL(/\/drafts\/[^/]+$/u);
  const draftRow = nav.locator('.agent-thread-row.status-draft');
  const quickDelete = draftRow.getByRole('button', {
    name: /^Delete draft /u,
  });
  await expect(draftRow.locator('.agent-thread-glyph')).toHaveText('✎');
  await expect(quickDelete).toHaveCSS('opacity', '0');
  await quickDelete.hover();
  await expect(quickDelete).toHaveCSS('opacity', '1');
  await quickDelete.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('pi-dashboard-drafts:v1') ?? '[]'),
      ),
    )
    .toEqual([]);

  const zeroPage = await page.context().newPage();
  await routeSidebarData(zeroPage);
  await installDashboardBootstrap(zeroPage, {
    serverId: 'dashboard-zero-project',
    revision: 1,
    cursor: 1,
    runtimes: [],
    projects: [],
    sessions: [],
    unread: [],
  } as never);
  await zeroPage.goto('/');
  await zeroPage
    .getByRole('complementary', { name: 'Agents and threads' })
    .getByRole('button', { name: /New thread/ })
    .click();
  await expect(zeroPage).toHaveURL(/\/projects$/u);
  await zeroPage.close();
});

test('desktop project scope filters threads and starts project threads @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/threads*', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/session-threads', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-sidebar-scope',
    revision: 1,
    cursor: 1,
    runtimes: [],
    projects: [
      { id: 'one', title: 'One', rootPath: '/work/one', status: 'active' },
      { id: 'two', title: 'Two', rootPath: '/work/two', status: 'active' },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `extra-${index}`,
        title: `Extra ${index}`,
        rootPath: `/work/extra-${index}`,
        status: 'active',
      })),
    ],
    sessions: [
      {
        id: 'one-session',
        cwd: '/work/one',
        projectId: 'one',
        title: 'One thread',
        updatedAt: 2,
      },
      {
        id: 'two-session',
        cwd: '/work/two',
        projectId: 'two',
        title: 'Two thread',
        updatedAt: 1,
      },
    ],
    unread: [],
  } as never);

  await page.goto('/');
  const nav = page.getByRole('complementary', {
    name: 'Agents and threads',
  });
  await expect(
    nav.getByRole('button', { name: /One thread ready/ }),
  ).toBeVisible();
  await expect(
    nav.getByRole('button', { name: /Two thread ready/ }),
  ).toBeVisible();
  const activeThread = nav.locator('[data-row-density="card"]').first();
  await expect(activeThread).toContainText(/One|Two/);
  await expect(activeThread).toContainText('Resumes on send');
  await expect(activeThread).not.toContainText('/work/');
  await nav.getByRole('button', { name: /New thread/ }).click();
  const projectChooser = page.getByRole('dialog', {
    name: 'Choose a project',
  });
  await expect(projectChooser).toBeVisible();
  await expect(
    projectChooser.getByRole('option', { name: /One/ }),
  ).toBeVisible();
  await expect(
    projectChooser.getByRole('option', { name: /Two/ }),
  ).toBeVisible();
  expect(
    await projectChooser.evaluate(
      (element) => element.parentElement?.parentElement === document.body,
    ),
  ).toBe(true);
  const chooserGeometry = await projectChooser.evaluate((element) => {
    const options = element.querySelector('.surface-scroll-region');
    return {
      dialogHeight: element.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
      optionsClientHeight: options?.clientHeight ?? 0,
      optionsScrollHeight: options?.scrollHeight ?? 0,
    };
  });
  expect(chooserGeometry.dialogHeight).toBeLessThanOrEqual(
    chooserGeometry.viewportHeight * 0.75,
  );
  expect(chooserGeometry.optionsScrollHeight).toBeGreaterThan(
    chooserGeometry.optionsClientHeight,
  );
  const chooserSearch = projectChooser.getByRole('combobox', {
    name: 'Search projects',
  });
  await chooserSearch.fill('Two');
  await expect(projectChooser.getByRole('option', { name: /One/ })).toHaveCount(
    0,
  );
  await chooserSearch.fill('');
  await chooserSearch.press('Control+j');
  await expect(
    projectChooser.getByRole('option', { selected: true }),
  ).toContainText('Two');
  await chooserSearch.press('Control+k');
  await expect(
    projectChooser.getByRole('option', { selected: true }),
  ).toContainText('One');
  await chooserSearch.press('Control+j');
  await chooserSearch.press('Enter');
  await expect(page).toHaveURL(/\/drafts\/[^/]+$/u);
  await page.goto('/');
  await nav.getByRole('button', { name: /New thread/ }).click();
  const chooserClose = projectChooser.getByRole('button', {
    name: 'Close Choose a project',
  });
  await chooserClose.focus();
  await chooserClose.press('Enter');
  await expect(projectChooser).toHaveCount(0);
  await expect(nav.getByRole('button', { name: /New thread/ })).toBeFocused();
  await page.goto('/');
  await nav
    .getByRole('combobox', { name: 'Project scope' })
    .selectOption('two');
  await expect(
    nav.getByRole('button', { name: /One thread ready/ }),
  ).toHaveCount(0);
  await expect(
    nav.getByRole('button', { name: /Two thread ready/ }),
  ).toBeVisible();
  await nav.getByRole('button', { name: /New thread/ }).click();
  await expect(projectChooser).toBeVisible();
  await projectChooser.getByRole('option', { name: /Two/ }).click();
  await expect(page).toHaveURL(/\/drafts\/[^/]+$/u);
  await page.goto('/projects');
  const projectCards = page.locator('.workspace-card');
  await expect(projectCards.first()).toContainText('One');
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page
    .getByRole('combobox', {
      name: 'Search commands, threads, and projects',
    })
    .fill('project');
  const paletteProjectItems = page
    .getByRole('group', { name: 'Projects' })
    .getByRole('option');
  await expect(paletteProjectItems.first()).toContainText('One');
  await expect(paletteProjectItems.nth(1)).toContainText('Two');
});

test('desktop project thread form stays readable @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/projects/one/git-context', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        branch: 'main',
        dirty: false,
        changedFileCount: 0,
        localBranches: ['main'],
      }),
    }),
  );
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-project-thread-geometry',
    revision: 1,
    cursor: 1,
    runtimes: [],
    projects: [
      { id: 'one', title: 'One', rootPath: '/work/one', status: 'active' },
    ],
    checkouts: [
      {
        id: 'checkout-one-main',
        projectId: 'one',
        kind: 'main',
        path: '/work/one',
        branch: 'main',
        status: 'ready',
        updatedAt: 1,
      },
    ],
    sessions: [],
    unread: [],
  } as never);

  await page.goto('/projects/one/new');
  const form = page.getByRole('textbox', { name: 'Message Pi' });
  await expect(form).toBeVisible();
  const geometry = await form.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      right: rect.right,
      viewport: window.innerWidth,
    };
  });
  expect(geometry.width).toBeLessThanOrEqual(832);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
  const locationControl = page.getByRole('button', {
    name: 'Checkout location',
  });
  const agentControl = page.getByRole('button', {
    name: 'Agent and thinking',
  });
  await expect(locationControl).toContainText('Current checkout · main');
  await expect(agentControl).toHaveText(/Agent/u);
  const triggerBox = await locationControl.boundingBox();
  await locationControl.click();
  const desktopLocationPicker = page.getByRole('dialog', {
    name: 'Checkout location',
  });
  await expect(desktopLocationPicker).toBeVisible();
  const locationBackdropStyle = await page
    .getByRole('button', { name: 'Close Checkout location' })
    .evaluate((backdrop) => ({
      borderStyle: getComputedStyle(backdrop).borderStyle,
      cursor: getComputedStyle(backdrop).cursor,
    }));
  expect(locationBackdropStyle).toEqual({
    borderStyle: 'none',
    cursor: 'default',
  });
  const pickerBox = await desktopLocationPicker.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(pickerBox).not.toBeNull();
  expect(pickerBox?.width ?? 0).toBeLessThanOrEqual(340);
  expect(pickerBox?.y ?? 0).toBeLessThan(triggerBox?.y ?? 0);
  await page.getByRole('button', { name: 'Close Checkout location' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Checkout location' }),
  ).toHaveCount(0);
  await agentControl.click();
  await expect(
    page.getByRole('dialog', { name: 'Agent and thinking' }),
  ).toBeVisible();
  expect(
    await page
      .getByRole('button', { name: 'Close Agent and thinking' })
      .evaluate((backdrop) => ({
        borderStyle: getComputedStyle(backdrop).borderStyle,
        cursor: getComputedStyle(backdrop).cursor,
      })),
  ).toEqual(locationBackdropStyle);
  await page.getByRole('button', { name: 'Close Agent and thinking' }).click();
});

test('modifier selection archives a settled thread range in bulk @desktop', async ({
  page,
}) => {
  const sessions = ['First settled', 'Second settled', 'Third settled'].map(
    (title, index) => ({
      id: `session-bulk-${index + 1}`,
      title,
      file: `/tmp/session-bulk-${index + 1}.jsonl`,
      cwd: '/tmp/bulk-selection',
      startedAt: 30 - index,
      updatedAt: 30 - index,
    }),
  );
  let listedThreads = sessions.map((session, index) => ({
    id: `thread-bulk-${index + 1}`,
    projectId: 'project-bulk',
    title: session.title,
    status: 'completed',
    settledAt: 20 - index,
    createdAt: 1,
    updatedAt: 20 - index,
  }));
  const archivedThreadIds: string[] = [];
  let releaseArchiveRequests: (() => void) | undefined;
  const archiveRequestsReleased = new Promise<void>((resolve) => {
    releaseArchiveRequests = resolve;
  });
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-bulk-selection',
    revision: 1,
    cursor: 1,
    projects: [
      {
        id: 'project-bulk',
        title: 'Bulk project',
        rootPath: '/tmp/bulk-selection',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    checkouts: [],
    runtimes: [],
    sessions,
    runs: sessions.map((session, index) => ({
      id: `run-bulk-${index + 1}`,
      threadId: `thread-bulk-${index + 1}`,
      checkoutId: `checkout-bulk-${index + 1}`,
      attempt: 1,
      mode: 'write',
      runtimeProvider: 'extension-bridge',
      piSessionId: session.id,
      initialPrompt: session.title,
      status: 'completed',
      createdAt: 1,
      finishedAt: 2,
    })),
    unread: [],
  } as never);
  await page.route('**/api/session-threads', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/threads**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(listedThreads),
      });
      return;
    }
    if (!pathname.endsWith('/archive'))
      throw new Error(`Unexpected bulk thread request: ${pathname}`);
    const threadId = pathname.split('/').at(-2);
    if (!threadId) throw new Error(`Missing thread ID in ${pathname}`);
    archivedThreadIds.push(threadId);
    await archiveRequestsReleased;
    listedThreads = listedThreads.map((thread) =>
      thread.id === threadId ? { ...thread, archivedAt: Date.now() } : thread,
    );
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        listedThreads.find((thread) => thread.id === threadId),
      ),
    });
  });

  await page.goto('/');
  const nav = page.getByRole('complementary', { name: 'Agents and threads' });
  const first = nav.getByRole('button', { name: /^First settled /u });
  const second = nav.getByRole('button', { name: /^Second settled /u });
  const third = nav.getByRole('button', { name: /^Third settled /u });

  await second.click();
  await expect(page).toHaveURL(/\/sessions\/session-bulk-2$/u);
  await page.goBack();
  await expect(first).toBeVisible();

  await first.click({ modifiers: ['Meta'] });
  await third.click({ modifiers: ['Shift'] });
  const toolbar = nav.getByRole('toolbar', {
    name: 'Actions for 3 selected threads',
  });
  await expect(toolbar).toContainText('3 selected');
  await expect(toolbar.getByRole('button', { name: 'Archive' })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Archive' }).click();
  await expect(first).toBeDisabled();
  await expect(second).toBeDisabled();
  await expect(third).toBeDisabled();
  releaseArchiveRequests?.();

  await expect
    .poll(() => archivedThreadIds.sort())
    .toEqual(['thread-bulk-1', 'thread-bulk-2', 'thread-bulk-3']);
  await expect(toolbar).toHaveCount(0);
  await expect(
    nav.getByRole('button', { name: 'Expand Archived' }),
  ).toBeVisible();
});

test('durable lifecycle controls require an exact persisted run mapping @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  const durableThread = {
    id: 'thread-durable',
    projectId: 'project-durable',
    title: 'Durable session',
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
  };
  const conflictingThread = {
    id: 'thread-conflicting',
    projectId: 'project-durable',
    title: 'Conflicting session',
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
  };
  let listedThreads = [durableThread, conflictingThread];
  const settledAt = Date.now() - 120_000;
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-durable-controls',
    revision: 1,
    cursor: 1,
    runtimes: [
      {
        runtimeId: 'runtime-durable',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp/durable-controls',
        liveState: 'working',
        online: false,
        session: {
          id: 'session-durable',
          title: 'Durable session',
          entries: [],
        },
      },
      {
        runtimeId: 'runtime-conflicting',
        ownership: 'external',
        pid: 2,
        cwd: '/tmp/durable-controls',
        liveState: 'working',
        online: true,
        session: {
          id: 'session-conflicting',
          title: 'Conflicting session',
          entries: [],
        },
      },
    ],
    workspaces: [],
    sessions: [
      {
        id: 'session-durable',
        file: '/tmp/session-durable.jsonl',
        cwd: '/tmp/durable-controls',
        updatedAt: 7,
      },
      {
        id: 'session-conflicting',
        file: '/tmp/session-conflicting.jsonl',
        cwd: '/tmp/durable-controls',
        updatedAt: 8,
      },
    ],
    runs: [
      {
        id: 'run-durable',
        threadId: 'thread-durable',
        checkoutId: 'checkout-durable',
        attempt: 1,
        mode: 'write',
        runtimeProvider: 'extension-bridge',
        piSessionId: 'session-durable',
        initialPrompt: 'Run durable',
        status: 'completed',
        createdAt: 1,
        finishedAt: 2,
      },
      {
        id: 'run-conflicting-a',
        threadId: 'thread-durable',
        checkoutId: 'checkout-durable',
        attempt: 1,
        mode: 'write',
        runtimeProvider: 'extension-bridge',
        piSessionId: 'session-conflicting',
        initialPrompt: 'Run conflicting A',
        status: 'completed',
        createdAt: 1,
        finishedAt: 2,
      },
      {
        id: 'run-conflicting-b',
        threadId: 'thread-conflicting',
        checkoutId: 'checkout-durable',
        attempt: 1,
        mode: 'write',
        runtimeProvider: 'extension-bridge',
        piSessionId: 'session-conflicting',
        initialPrompt: 'Run conflicting B',
        status: 'completed',
        createdAt: 1,
        finishedAt: 2,
      },
    ],
    unread: [],
  } as never);
  await page.route('**/api/session-threads', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/threads**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(listedThreads),
      });
      return;
    }
    if (pathname.endsWith('/pin')) {
      listedThreads = listedThreads.map((thread) =>
        thread.id === 'thread-durable' ? { ...thread, pinnedAt: 3 } : thread,
      );
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(listedThreads[0]),
      });
      return;
    }
    if (pathname.endsWith('/unpin')) {
      listedThreads = listedThreads.map(({ pinnedAt, ...thread }) => thread);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(listedThreads[0]),
      });
      return;
    }
    if (pathname.endsWith('/settle')) {
      listedThreads = listedThreads.map((thread) =>
        thread.id === 'thread-durable' ? { ...thread, settledAt } : thread,
      );
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(listedThreads[0]),
      });
      return;
    }
    if (pathname.endsWith('/archive')) {
      listedThreads = listedThreads.map((thread) =>
        thread.id === 'thread-durable' ? { ...thread, archivedAt: 4 } : thread,
      );
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(listedThreads[0]),
      });
      return;
    }
    if (pathname.endsWith('/restore')) {
      listedThreads = listedThreads.map(({ archivedAt, ...thread }) => thread);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(listedThreads[0]),
      });
      return;
    }
    throw new Error(`Unexpected durable thread request: ${pathname}`);
  });

  await page.goto('/');
  const nav = page.getByRole('complementary', { name: 'Agents and threads' });
  const durableRow = nav.locator('.agent-thread-row').filter({
    hasText: 'Durable session',
  });
  const conflictingRow = nav.locator('.agent-thread-row').filter({
    hasText: 'Conflicting session',
  });
  await expect(durableRow).toBeVisible();
  await expect(conflictingRow).toBeVisible();
  const durableThreadLink = durableRow.getByRole('button', {
    name: /^Durable session /u,
  });
  const conflictingThreadLink = conflictingRow.getByRole('button', {
    name: /^Conflicting session /u,
  });
  const quickSettle = durableRow.getByRole('button', {
    name: 'Settle Durable session',
  });
  await expect(quickSettle).toHaveCSS('opacity', '0');
  await durableRow.hover();
  await expect(quickSettle).toHaveCSS('opacity', '1');
  await expect(
    conflictingRow.getByRole('button', {
      name: 'Settle Conflicting session',
    }),
  ).toHaveCount(0);

  await durableThreadLink.click({ button: 'right' });
  const durableMenu = page.getByRole('menu', {
    name: 'Actions for Durable session',
  });
  await expect(
    durableMenu.getByRole('menuitem', { name: 'Pin' }),
  ).toBeVisible();
  await expect(
    durableMenu.getByRole('menuitem', { name: 'Archive' }),
  ).toBeVisible();
  await durableMenu.getByRole('menuitem', { name: 'Pin' }).click();
  await expect(durableMenu).toHaveCount(0);
  await expect(durableRow.locator('[data-row-density="card"]')).toHaveCount(1);
  await expect(durableRow.locator('.agent-thread-time')).toHaveAttribute(
    'datetime',
    new Date(7).toISOString(),
  );
  await expect(durableRow.getByRole('img', { name: 'Pinned' })).toBeVisible();

  await durableThreadLink.press('ContextMenu');
  await expect(
    page
      .getByRole('menu', { name: 'Actions for Durable session' })
      .getByRole('menuitem', { name: 'Unpin' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await durableThreadLink.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Actions for Durable session' })
    .getByRole('menuitem', { name: 'Archive' })
    .click();
  const archivedShelf = nav.getByRole('button', {
    name: 'Expand Archived',
  });
  await expect(archivedShelf).toHaveAttribute('aria-expanded', 'false');
  await expect(durableRow).toHaveCount(0);
  await archivedShelf.click();
  await expect(durableRow).toBeVisible();
  await expect(durableRow.locator('[data-row-density="slim"]')).toHaveCount(1);
  await expect(durableRow.locator('.agent-thread-time')).toHaveAttribute(
    'datetime',
    new Date(7).toISOString(),
  );
  await durableThreadLink.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Actions for Durable session' })
    .getByRole('menuitem', { name: 'Restore' })
    .click();
  await expect(
    nav.getByRole('button', { name: /Expand Archived/u }),
  ).toHaveCount(0);
  await expect(durableRow).toBeVisible();

  await durableThreadLink.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Actions for Durable session' })
    .getByRole('menuitem', { name: 'Unpin' })
    .click();
  await durableThreadLink.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Actions for Durable session' })
    .getByRole('menuitem', { name: 'Settle' })
    .click();
  await expect(
    nav.getByRole('region', { name: 'Completed threads' }),
  ).toBeVisible();
  await expect(durableRow.locator('[data-row-density="slim"]')).toHaveCount(1);
  await expect(durableRow.locator('.agent-thread-time')).toHaveAttribute(
    'datetime',
    new Date(settledAt).toISOString(),
  );
  await expect(durableRow.locator('.agent-thread-time')).toHaveText(/\S/u);
  await expect
    .poll(() =>
      durableRow.evaluate((element) => getComputedStyle(element).userSelect),
    )
    .toBe('none');

  await conflictingThreadLink.click({ button: 'right' });
  const conflictingMenu = page.getByRole('menu', {
    name: 'Actions for Conflicting session',
  });
  await expect(
    conflictingMenu.getByRole('menuitem', {
      name: 'Mark Conflicting session as unread',
    }),
  ).toBeVisible();
  await expect(
    conflictingMenu.getByRole('menuitem', { name: 'Pin' }),
  ).toHaveCount(0);
  await expect(
    conflictingMenu.getByRole('menuitem', { name: 'Archive' }),
  ).toHaveCount(0);
});

test('runtime row lifecycle menu supports desktop, touch, and keyboard access', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-context-menu',
    revision: 1,
    cursor: 1,
    runtimes: [
      {
        runtimeId: 'runtime-context-menu',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp/context-menu',
        liveState: 'working',
        online: true,
        session: {
          id: 'session-context-menu',
          title: 'Context menu session',
          entries: [],
        },
      },
    ],
    workspaces: [],
    sessions: [
      {
        id: 'session-context-menu',
        file: '',
        cwd: '/tmp/context-menu',
        title: 'Context menu session',
        updatedAt: Date.now(),
      },
    ],
    unread: [],
  });
  await page.route('**/api/sessions/session-context-menu', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        metadata: {
          id: 'session-context-menu',
          file: '',
          cwd: '/tmp/context-menu',
          title: 'Context menu session',
          updatedAt: Date.now(),
        },
        entries: [],
        entriesComplete: true,
      }),
    }),
  );

  await page.goto('/');
  const row = page.locator('.agent-thread-row.status-working');
  const thread = row.getByRole('button', {
    name: 'Context menu session working',
  });
  await expect(thread).toHaveAttribute('aria-haspopup', 'menu');
  await expect(row.locator('.agent-thread-actions-trigger')).toHaveCount(0);

  const rowBox = await row.boundingBox();
  if (!rowBox) throw new Error('Runtime row is not laid out.');
  await page.mouse.click(rowBox.x + 2, rowBox.y + rowBox.height / 2);
  await expect(page).toHaveURL(/\/sessions\/session-context-menu$/u);
  await page.goto('/');
  await expect(row).toBeVisible();

  const menu = page.getByRole('menu', {
    name: 'Actions for Context menu session',
  });
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const cursorPoint = {
    x: rowBox.x + Math.min(24, rowBox.width / 2),
    y: rowBox.y + rowBox.height / 2,
  };
  await page.mouse.click(cursorPoint.x, cursorPoint.y, { button: 'right' });
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole('menuitem', {
      name: 'Mark Context menu session as unread',
    }),
  ).toBeVisible();
  await expect(
    menu.getByRole('menuitem', {
      name: 'Copy path for Context menu session',
    }),
  ).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Stop' })).toBeVisible();
  const cursorMenuBox = await menu.boundingBox();
  if (!cursorMenuBox) throw new Error('Context menu is not laid out.');
  expect(Math.abs(cursorMenuBox.x - cursorPoint.x)).toBeLessThan(2);
  expect(Math.abs(cursorMenuBox.y - cursorPoint.y)).toBeLessThan(2);
  expect(
    await menu.evaluate((element) => element.parentElement === document.body),
  ).toBe(true);
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(thread).toBeFocused();

  const edgePoint = { x: viewport.width - 2, y: viewport.height - 2 };
  await row.evaluate((element, point) => {
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
      }),
    );
  }, edgePoint);
  await expect(menu).toBeVisible();
  const edgeMenuBox = await menu.boundingBox();
  if (!edgeMenuBox) throw new Error('Edge context menu is not laid out.');
  expect(edgeMenuBox.x).toBeGreaterThanOrEqual(8);
  expect(edgeMenuBox.y).toBeGreaterThanOrEqual(8);
  expect(edgeMenuBox.x + edgeMenuBox.width).toBeLessThanOrEqual(
    viewport.width - 8,
  );
  expect(edgeMenuBox.y + edgeMenuBox.height).toBeLessThanOrEqual(
    viewport.height - 8,
  );
  expect(edgeMenuBox.x).toBeLessThan(edgePoint.x);
  expect(edgeMenuBox.y).toBeLessThan(edgePoint.y);
  await page.keyboard.press('Escape');

  await thread.press('Shift+F10');
  await expect(menu).toBeVisible();
  const keyboardButtonBox = await thread.boundingBox();
  const keyboardMenuBox = await menu.boundingBox();
  if (!keyboardButtonBox || !keyboardMenuBox)
    throw new Error('Keyboard context menu is not laid out.');
  expect(Math.abs(keyboardMenuBox.x - keyboardButtonBox.x)).toBeLessThan(2);
  expect(
    Math.abs(
      keyboardMenuBox.y - (keyboardButtonBox.y + keyboardButtonBox.height),
    ),
  ).toBeLessThan(2);
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await thread.press('ContextMenu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');

  const longPressPoint = { x: 52, y: 220 };
  await row.evaluate((element, point) => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 17,
        pointerType: 'touch',
        clientX: point.x,
        clientY: point.y,
      }),
    );
  }, longPressPoint);
  await page.waitForTimeout(550);
  await expect(menu).toBeVisible();
  const longPressMenuBox = await menu.boundingBox();
  if (!longPressMenuBox) throw new Error('Long-press menu is not laid out.');
  expect(Math.abs(longPressMenuBox.x - longPressPoint.x)).toBeLessThan(2);
  expect(Math.abs(longPressMenuBox.y - longPressPoint.y)).toBeLessThan(2);
  await row.evaluate((element, point) => {
    element.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 17,
        pointerType: 'touch',
        clientX: point.x,
        clientY: point.y,
      }),
    );
  }, longPressPoint);
  await thread.click();
  await expect(page).toHaveURL(/\/$/u);
  await expect(menu).toHaveCount(0);

  await row.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 18,
        pointerType: 'touch',
        clientX: 20,
        clientY: 20,
      }),
    );
    element.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 18,
        pointerType: 'touch',
        clientX: 32,
        clientY: 20,
      }),
    );
  });
  await page.waitForTimeout(550);
  await expect(menu).toHaveCount(0);

  await thread.click();
  await expect(page).toHaveURL(/\/sessions\/session-context-menu$/u);
  const abort = page.locator('.composer-abort');
  await expect(abort).toBeVisible();
  await expect
    .poll(() =>
      abort.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    )
    .toEqual({ width: 38, height: 38 });
});

test('session title supports reliable inline renaming', async ({ page }) => {
  const session = {
    id: 'session-rename',
    file: '',
    cwd: '/tmp/project',
    title: 'Original title',
    updatedAt: Date.now(),
  };
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-rename',
    revision: 1,
    cursor: 1,
    runtimes: [
      {
        runtimeId: 'runtime-rename',
        ownership: 'external',
        pid: 1,
        cwd: session.cwd,
        liveState: 'idle',
        online: true,
        session: { id: session.id, title: session.title, entries: [] },
      },
    ],
    workspaces: [],
    sessions: [session],
    unread: [],
  });
  await page.route('**/api/sessions/session-rename', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        metadata: session,
        entries: [
          {
            type: 'message',
            message: { role: 'user', content: 'Original request' },
          },
        ],
        entriesComplete: true,
      }),
    }),
  );
  let failNextRename = false;
  const renamedValues: string[] = [];
  await page.route('**/trpc/renameSession', async (route) => {
    const input = dashboardTrpcInput(route.request());
    const name = typeof input.name === 'string' ? input.name : '';
    renamedValues.push(name);
    if (failNextRename) {
      failNextRename = false;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            message: 'Rename unavailable',
            code: -32603,
            data: {
              code: 'INTERNAL_SERVER_ERROR',
              httpStatus: 500,
              path: 'renameSession',
            },
          },
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        commandId: input.commandId,
        status: 'completed',
        result: { sessionId: input.sessionId, name },
      }),
    });
  });

  await page.goto('/sessions/session-rename');
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText('Original title');

  await page
    .getByRole('button', { name: 'Rename session: Original title' })
    .dblclick();
  const input = page.getByRole('textbox', { name: 'Session name' });
  await expect(input).toBeFocused();
  await input.fill('Renamed title');
  await input.press('Enter');
  await expect(heading).toHaveText('Renamed title');
  expect(renamedValues).toEqual(['Renamed title']);

  await page
    .getByRole('button', { name: 'Rename session: Renamed title' })
    .dblclick();
  await input.fill('Discarded title');
  await input.press('Escape');
  await expect(heading).toHaveText('Renamed title');
  expect(renamedValues).toEqual(['Renamed title']);

  failNextRename = true;
  await page
    .getByRole('button', { name: 'Rename session: Renamed title' })
    .dblclick();
  await input.fill('Broken title');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Rename unavailable');
  await expect(input).toBeFocused();
  await input.fill('Recovered title');
  await input.press('Enter');
  await expect(heading).toHaveText('Recovered title');
  expect(renamedValues).toEqual([
    'Renamed title',
    'Broken title',
    'Recovered title',
  ]);
});

test('command palette supports fuzzy keyboard search and surface handoff @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-palette-desktop',
    revision: 1,
    cursor: 1,
    runtimes: [
      {
        runtimeId: 'runtime-palette',
        ownership: 'external',
        pid: 1,
        cwd: '/workspace/dashboard',
        liveState: 'working',
        online: true,
        session: {
          id: 'runtime-session',
          title: 'Dashboard agent',
          entries: [],
        },
        capabilities: {
          version: 1,
          capabilities: [],
          manifests: [
            {
              id: 'runtime-manifest',
              version: '1',
              actions: [{ id: 'runtime.abort', title: 'Abort run' }],
              renderers: [],
            },
          ],
        },
      },
    ],
    projects: [
      {
        id: 'project-1',
        title: 'Dashboard project',
        rootPath: '/workspace/dashboard',
        status: 'active',
      },
    ],
    checkouts: [
      {
        id: 'checkout-1',
        projectId: 'project-1',
        kind: 'worktree',
        path: '/workspace/.worktrees/palette',
        branch: 'feature/palette',
        status: 'ready',
        updatedAt: 1,
      },
    ],
    sessions: [
      {
        id: 'runtime-session',
        cwd: '/workspace/dashboard',
        title: 'Dashboard agent',
        updatedAt: 100,
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `decoy-session-${index}`,
        cwd: '/workspace/dashboard',
        title: `Dashboard history ${index}`,
        updatedAt: index + 2,
      })),
      {
        id: 'session-1',
        cwd: '/workspace/dashboard',
        projectId: 'project-1',
        checkoutId: 'checkout-1',
        title: 'Reconnect diagnostics',
        startedAt: 1,
        updatedAt: 1,
      },
    ],
    unread: [],
  } as never);

  await page.goto('/sessions/runtime-session');
  await expect(
    page.getByRole('heading', { name: 'Rename session: Dashboard agent' }),
  ).toBeVisible();
  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  const search = palette.getByRole('combobox', {
    name: 'Search commands, threads, and projects',
  });
  await expect(search).toBeFocused();
  await expect(palette.getByRole('button', { name: /Clear/ })).toHaveCount(0);
  await search.press('Control+j');
  await expect(palette.getByRole('option', { selected: true })).toContainText(
    'Abort run',
  );
  await search.press('Control+k');
  await expect(palette.getByRole('option', { selected: true })).toContainText(
    'New thread',
  );
  await search.press('End');
  await expect(palette.getByRole('option', { selected: true })).toContainText(
    'Projects',
  );
  await search.press('ArrowDown');
  await expect(palette.getByRole('option', { selected: true })).toContainText(
    'Projects',
  );
  await search.press('Home');
  await expect(palette.getByRole('option', { selected: true })).toContainText(
    'New thread',
  );
  await search.press('PageDown');
  await expect(palette.getByRole('option', { selected: true })).toHaveAttribute(
    'data-thread-lifecycle',
    /active|settled|archived/u,
  );
  await search.press('PageUp');
  await expect(palette.getByRole('option', { selected: true })).toContainText(
    'New thread',
  );
  const paletteBox = await palette.boundingBox();
  expect(paletteBox).not.toBeNull();
  expect(
    Math.abs((paletteBox?.x ?? 0) + (paletteBox?.width ?? 0) / 2 - 720),
  ).toBeLessThan(2);

  await search.fill('reconect');
  await expect(
    palette.getByRole('button', { name: 'Clear command palette search' }),
  ).toHaveCount(1);
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(palette).toBeVisible();
  await search.press('Escape');
  await expect(palette).toHaveCount(0);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await expect(search).toBeFocused();
  await search.fill('reconect');
  const fuzzyResult = palette.getByRole('option', {
    name: /Reconnect diagnostics/,
  });
  await expect(fuzzyResult).toBeVisible();
  await expect(fuzzyResult.locator('mark')).not.toHaveCount(0);
  await expect(fuzzyResult).toContainText(
    'Dashboard project / feature/palette',
  );
  await expect(fuzzyResult).toContainText('ready');
  await expect(fuzzyResult.locator('.palette-thread-created')).toHaveAttribute(
    'datetime',
    '1970-01-01T00:00:00.001Z',
  );
  await expect(
    fuzzyResult.locator('.palette-thread-location > span').first(),
  ).toHaveAttribute(
    'title',
    'worktree checkout: /workspace/.worktrees/palette',
  );
  const activeDescendant = await search.getAttribute('aria-activedescendant');
  expect(activeDescendant).toBeTruthy();
  await expect(page.locator(`[id="${activeDescendant}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await search.fill('feature/palette');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await expect(palette.getByRole('option')).toContainText(
    'Reconnect diagnostics',
  );

  await search.fill('> new');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await search.press('Enter');
  await expect(palette).toHaveCount(0);
  const chooser = page.getByRole('dialog', { name: 'Choose a project' });
  await expect(chooser).toBeVisible();
  await expect(
    chooser.getByRole('combobox', { name: 'Search projects' }),
  ).toBeFocused();
  await chooser.getByRole('button', { name: 'Close Choose a project' }).click();
  await expect(
    page.getByRole('button', { name: 'Open command palette' }),
  ).toBeFocused();
});

test('command palette identifies the runtime before invoking repeated actions', async ({
  page,
}) => {
  const runtime = (runtimeId: string, title: string, cwd: string) => ({
    runtimeId,
    ownership: 'external' as const,
    pid: 1,
    cwd,
    liveState: 'working' as const,
    online: true,
    session: { id: `session-${runtimeId}`, title, entries: [] },
    capabilities: {
      version: 1 as const,
      capabilities: [],
      manifests: [
        {
          id: `manifest-${runtimeId}`,
          version: '1',
          actions: [{ id: 'runtime.abort', title: 'Abort run' }],
          renderers: [],
        },
      ],
    },
  });
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-palette',
    revision: 1,
    cursor: 1,
    runtimes: [
      runtime('runtime-alpha', 'Alpha agent', '/workspace/alpha'),
      runtime('runtime-beta', 'Beta agent', '/workspace/beta'),
    ],
    workspaces: [],
    sessions: [],
    unread: [],
  });
  let invokedRuntime: string | undefined;
  await page.route('**/trpc/runtimeCommand', async (route) => {
    const input = dashboardTrpcInput(route.request());
    const command = input.command as Record<string, unknown> | undefined;
    invokedRuntime =
      typeof input.runtimeId === 'string' ? input.runtimeId : undefined;
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        runtimeId: input.runtimeId,
        commandId: command?.id,
        status: 'completed',
        result: { accepted: true },
      }),
    });
  });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Open command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Control+k');
  await page
    .getByRole('combobox', {
      name: 'Search commands, threads, and projects',
    })
    .fill('runtime-beta');
  const option = page.getByRole('option', { name: /Abort run/ });
  await expect(option).toHaveCount(1);
  await expect(option).toContainText('Beta agent · /workspace/beta');
  await option.click();
  await expect.poll(() => invokedRuntime).toBe('runtime-beta');
});

test('session shell shows compaction progress', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('pi-dashboard-token', 'test-token'),
  );
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  const commands: unknown[] = [];
  await page.route('**/trpc/runtimeCommand', async (route) => {
    const input = dashboardTrpcInput(route.request());
    const command = input.command as Record<string, unknown> | undefined;
    commands.push(command);
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        runtimeId: input.runtimeId,
        commandId: command?.id,
        status: 'completed',
        result: { accepted: true },
      }),
    });
  });
  const runtime = {
    runtimeId: 'runtime-compacting',
    ownership: 'external',
    pid: 1,
    cwd: '/tmp',
    liveState: 'compacting',
    online: true,
    session: {
      id: 'session-compacting',
      title: 'Compacting session',
      entries: [],
      entriesComplete: true,
    },
  } as const;
  const metadata = {
    id: 'session-compacting',
    file: '',
    cwd: '/tmp',
    title: 'Compacting session',
    updatedAt: Date.now(),
  };
  await installDashboardBootstrap(page, {
    serverId: 'server-compacting',
    revision: 1,
    cursor: 0,
    runtimes: [runtime],
    workspaces: [],
    sessions: [metadata],
    unread: [],
  });
  await page.route('**/api/sessions/session-compacting', async (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        serverId: 'server-compacting',
        cursor: 0,
        runtimeEpoch: 'epoch-compacting',
        runtimeSeq: 1,
        metadata,
        entries: [],
        entriesComplete: true,
      }),
    }),
  );

  await page.goto('/sessions/session-compacting');

  await expect(page.locator('.session-status')).toHaveText(/compacting/i);
  const compactionEvent = page.locator('.live-compaction-event');
  await expect(compactionEvent).toContainText('Compacting context…');
  await expect(compactionEvent).toContainText('in progress');
  await expect(
    page.getByText('Compacting context…', { exact: true }),
  ).toHaveCount(1);
  const composer = page.getByRole('textbox', {
    name: 'Message Pi',
    exact: true,
  });
  await expect(composer).toBeEditable();
  await composer.fill('Send after compaction');
  await expect(
    page.getByRole('button', { name: 'Queue message' }),
  ).toBeEnabled();
  await composer.press('Meta+Enter');
  await expect
    .poll(() => commands.at(-1))
    .toMatchObject({ type: 'queue.add', text: 'Send after compaction' });

  await page.getByRole('button', { name: 'Cancel context compaction' }).click();
  await expect
    .poll(() => commands.at(-1))
    .toMatchObject({
      type: 'compact.cancel',
    });
});

test('older active transcript events render before newer persisted history', async ({
  page,
}) => {
  const session = {
    id: 'session-active-chronology',
    file: '',
    cwd: '/tmp',
    title: 'Active chronology',
    updatedAt: Date.parse('2024-06-01T13:00:00.000Z'),
  };
  await installDashboardBootstrap(
    page,
    {
      serverId: 'server-active-chronology',
      revision: 1,
      cursor: 4,
      runtimes: [
        {
          runtimeId: 'runtime-active-chronology',
          ownership: 'external',
          pid: 1,
          cwd: session.cwd,
          liveState: 'working',
          online: true,
          session: { id: session.id, title: session.title, entries: [] },
        },
      ],
      workspaces: [],
      sessions: [session],
      unread: [],
    },
    {
      sessionSnapshot: {
        serverId: 'server-active-chronology',
        cursor: 4,
        runtimeEpoch: 'epoch-active-chronology',
        runtimeSeq: 2,
        entries: [
          {
            type: 'message',
            id: 'persisted-newer',
            message: {
              role: 'assistant',
              content: 'Newer persisted response',
              timestamp: '2024-06-01T13:00:00.000Z',
            },
          },
        ],
        entriesComplete: true,
        active: {
          runtimeId: 'runtime-active-chronology',
          runtimeEpoch: 'epoch-active-chronology',
          runtimeSeq: 2,
          messages: [
            {
              messageId: 'active-older',
              role: 'assistant',
              content: 'Older active response',
              timestamp: 1717243200000,
              turnId: 'turn-active-older',
              toolCallIds: ['active-older-tool'],
            },
          ],
          tools: [
            {
              toolCallId: 'active-older-tool',
              name: 'search',
              status: 'running',
              turnId: 'turn-active-older',
            },
          ],
          delegates: [],
          truncated: false,
        },
        completeThroughCursor: false,
      },
    },
  );

  await page.goto('/sessions/session-active-chronology');
  const transcript = page.locator('.transcript');
  await expect(transcript.getByText('Older active response')).toBeVisible();
  await expect(transcript.getByText('Newer persisted response')).toBeVisible();
  await expect
    .poll(async () =>
      (await transcript.locator('.markdown > p').allTextContents()).filter(
        (text) =>
          text === 'Older active response' ||
          text === 'Newer persisted response',
      ),
    )
    .toEqual(['Older active response', 'Newer persisted response']);
  await expect(
    page.getByRole('button', { name: /Older active response/ }),
  ).toHaveAccessibleDescription(/1 tool/);
});

test('session shell exposes timestamps, dormant state, and persistent drafts', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('pi-dashboard-token', 'test-token'),
  );
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await installDashboardBootstrap(
    page,
    {
      serverId: 'server-loading',
      revision: 1,
      cursor: 0,
      runtimes: [
        {
          runtimeId: 'runtime-loading',
          ownership: 'external',
          projectId: 'tmp-project',
          checkoutId: 'tmp-checkout',
          pid: 1,
          cwd: '/tmp',
          liveState: 'idle',
          online: true,
          model: {
            provider: 'test',
            model: 'careful',
            thinking: 'high',
          },
          modelCatalog: [
            { provider: 'test', model: 'careful', name: 'Careful' },
            { provider: 'test', model: 'fast', name: 'Fast' },
          ],
          thinkingLevels: ['off', 'high'],
          contextUsage: {
            tokens: 32,
            contextWindow: 100,
            percent: 32,
          },
          session: {
            id: 'session-loading',
            title: 'Loaded shell',
            entries: [],
          },
        },
      ],
      projects: [
        {
          id: 'tmp-project',
          title: 'Tmp project',
          rootPath: '/tmp',
          status: 'active',
        },
      ],
      checkouts: [
        {
          id: 'tmp-checkout',
          projectId: 'tmp-project',
          path: '/tmp',
          kind: 'main',
          branch: 'main',
          status: 'ready',
        },
      ],
      sessions: [
        {
          id: 'session-loading',
          file: '',
          cwd: '/tmp',
          projectId: 'tmp-project',
          checkoutId: 'tmp-checkout',
          title: 'Loaded shell',
          updatedAt: Date.parse('2026-08-05T18:42:00.000Z'),
        },
        {
          id: 'session-dormant',
          file: '',
          cwd: '/tmp/archive',
          projectId: 'tmp-project',
          checkoutId: 'tmp-checkout',
          title: 'Dormant thread',
          updatedAt: Date.parse('2026-08-04T12:00:00.000Z'),
          lastKnownModel: { provider: 'test', model: 'careful' },
          lastKnownThinking: 'high',
          lastKnownContextTokens: 42,
        },
      ],
      unread: [],
    },
    {
      sessionSubscribeDelayMs: 2_000,
      sessionSnapshots: {
        'session-dormant': {
          serverId: 'server-loading',
          cursor: 0,
          metadata: {
            id: 'session-dormant',
            file: '',
            cwd: '/tmp/archive',
            projectId: 'tmp-project',
            checkoutId: 'tmp-checkout',
            title: 'Dormant thread',
            updatedAt: Date.parse('2026-08-04T12:00:00.000Z'),
            lastKnownModel: { provider: 'test', model: 'careful' },
            lastKnownThinking: 'high',
            lastKnownContextTokens: 42,
          },
          entries: [
            ...Array.from({ length: 80 }, (_, index) => ({
              type: 'message',
              message: {
                id: `dormant-history-${index}`,
                role: 'user',
                content: `Dormant history ${index}`,
                timestamp: Date.parse('2026-08-04T10:00:00.000Z') + index,
              },
            })),
            {
              type: 'message',
              message: {
                id: 'dormant-history-latest',
                role: 'user',
                content: 'Dormant latest',
                timestamp: Date.parse('2026-08-04T11:00:00.000Z'),
              },
            },
          ],
        },
        'session-loading': {
          serverId: 'server-loading',
          cursor: 0,
          metadata: {
            id: 'session-loading',
            file: '',
            cwd: '/tmp',
            projectId: 'tmp-project',
            checkoutId: 'tmp-checkout',
            title: 'Loaded shell',
            updatedAt: 1,
          },
          entries: [
            ...Array.from({ length: 80 }, (_, index) => ({
              type: 'message',
              message: {
                id: `history-${index}`,
                role: 'user',
                content: `Earlier history ${index}`,
                timestamp: Date.parse('2026-08-05T17:00:00.000Z') + index,
              },
            })),
            {
              type: 'message',
              message: {
                id: 'history-latest',
                role: 'user',
                content: 'Prior history',
                timestamp: '2026-08-05T18:42:00.000Z',
              },
            },
          ],
        },
      },
    },
  );

  await page.goto('/sessions/session-loading');
  await expect(page.locator('.session-heading h1')).toHaveText('Loaded shell');
  await expect(page.locator('.session-transcript-loading')).toContainText(
    'Loading session…',
  );
  await expect(
    page.getByRole('button', { name: 'Open agent list' }),
  ).toBeVisible();
  await expect(page.getByRole('form', { name: 'Send a message' })).toHaveCount(
    0,
  );
  await expect(page.locator('.transcript-virtualized')).toContainText(
    'Prior history',
  );
  await expect(page.getByRole('link', { name: 'Tmp project' })).toHaveAttribute(
    'href',
    '/projects/tmp-project',
  );
  await expect(page.locator('.transcript-virtualized')).toHaveCount(1);
  await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(1);
  await expect(
    page
      .getByRole('article')
      .filter({ hasText: 'Prior history' })
      .getByRole('time'),
  ).toHaveAttribute('datetime', '2026-08-05T18:42:00.000Z');
  await page.getByRole('button', { name: 'Open transcript outline' }).click();
  const outline = page.getByRole('dialog', { name: 'Transcript outline' });
  const outlineMotion = await sharedDrawerMotion(outline);
  expect(outlineMotion).toMatchObject({
    animationName: 'drawer-in',
    animationDuration: '0.16s',
    animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
  });
  expect(outlineMotion.transforms).toContain('translateX(100%)');
  await expect(outline).toHaveClass(/work-surface-drawer/);
  await expect(outline.locator('h2')).toHaveCount(0);
  await expect(outline.locator('.eyebrow')).toHaveText('Transcript outline');
  await expect(outline.locator('.surface-drawer-summary')).toContainText(
    'Navigate transcript landmarks',
  );
  await expect(outline.locator('.surface-stats')).toContainText('landmarks');
  expect(
    await outline
      .locator('.surface-drawer-body')
      .evaluate((element) => getComputedStyle(element).padding),
  ).toBe('0px');
  await expect(
    outline.locator('.transcript-outline-time').first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close Transcript outline' }).click();

  await page.getByRole('button', { name: 'Open agent list' }).click();
  const agentNav = page.getByRole('complementary', {
    name: 'Agents and threads',
  });
  await expect(
    agentNav.getByRole('button', { name: 'Loaded shell ready' }),
  ).toBeVisible();
  await expect(
    agentNav.getByRole('button', { name: 'Dormant thread ready' }),
  ).toBeVisible();
  const loadedRow = agentNav
    .locator('.agent-thread-row')
    .filter({ hasText: 'Loaded shell' });
  const dormantRow = agentNav
    .locator('.agent-thread-row')
    .filter({ hasText: 'Dormant thread' });
  const loadedCard = loadedRow.locator('[data-row-density="card"]');
  const dormantCard = dormantRow.locator('[data-row-density="card"]');
  await expect(loadedCard).toHaveCount(1);
  await expect(dormantCard).toHaveCount(1);
  await expect(
    loadedCard.locator('[data-row-content="project"] > span').first(),
  ).toHaveText('Tmp project');
  await expect(loadedCard.locator('[data-row-content="context"]')).toHaveCount(
    0,
  );
  await expect(
    loadedCard.locator('[data-row-content="details"]'),
  ).toContainText('careful · high · 32 ctx');
  await expect(loadedCard.locator('.agent-thread-time')).toHaveCount(1);
  await expect(
    loadedCard.locator('[data-row-content="project"] .agent-thread-glyph'),
  ).toHaveCount(1);
  await expect(
    dormantCard.locator('[data-row-content="project"] > span').first(),
  ).toHaveText('Tmp project');
  await expect(dormantCard.locator('[data-row-content="context"]')).toHaveCount(
    0,
  );
  await expect(dormantCard).toContainText('Dormant thread');
  await expect(
    dormantCard.locator('[data-row-content="details"]'),
  ).toContainText('careful · high · 42 ctx');
  await expect(dormantCard.locator('.agent-thread-time')).toHaveCount(1);
  await expect(
    agentNav.locator('.agent-thread-row.status-idle .agent-thread-glyph'),
  ).toHaveText('●');
  await expect(
    agentNav.locator('.agent-thread-row.status-dormant .agent-thread-glyph'),
  ).toHaveText('◌');
  await expect(agentNav.locator('.agent-thread-time')).toHaveCount(2);
  await page.locator('.agent-nav-backdrop').click();

  const composer = page.getByLabel('Message Pi');
  await expect(composer).toBeVisible();
  const activeComposer = page.locator('form.composer');
  await expect(
    activeComposer.locator('.draft-picker-trigger-locked'),
  ).toContainText('Current checkout · main');
  await expect(
    activeComposer.getByRole('button', { name: 'Agent and thinking' }),
  ).toContainText('Careful· high');
  await expect(activeComposer.getByLabel('Model', { exact: true })).toHaveCount(
    0,
  );
  await composer.fill('Draft survives navigation and refresh');
  await transcriptScroll(page).evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    element.scrollTop = 0;
  });
  await expect
    .poll(() => transcriptScroll(page).evaluate((element) => element.scrollTop))
    .toBe(0);
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await page
    .getByRole('complementary', { name: 'Agents and threads' })
    .getByRole('button', { name: 'Dormant thread ready' })
    .click();
  await expect(page).toHaveURL(/\/sessions\/session-dormant$/u);
  const dormantComposer = page.locator('form.composer');
  await expect(dormantComposer).toBeVisible();
  await expect(
    dormantComposer.locator('.draft-picker-trigger-locked'),
  ).toContainText('Current checkout · main');
  const dormantAgent = dormantComposer.getByRole('button', {
    name: 'Agent and thinking',
  });
  await expect(dormantAgent).toContainText('Careful· high');
  await dormantAgent.click();
  await expect(
    page.getByRole('dialog', { name: 'Agent and thinking' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close Agent and thinking' }).click();
  await expect(
    dormantComposer.getByRole('img', {
      name: 'Context window 42% [42/100]',
    }),
  ).toBeVisible();
  await expect(page.locator('.composer-notice')).toHaveCount(0);
  await transcriptScroll(page).evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  const dormantJumpLatest = page.getByRole('button', {
    name: 'Jump to latest transcript activity',
  });
  await expect(dormantJumpLatest).toBeVisible();
  const dormantJumpBottom = await dormantJumpLatest.evaluate(
    (button) => button.getBoundingClientRect().bottom,
  );
  const dormantComposerTop = await dormantComposer.evaluate(
    (composerElement) => composerElement.getBoundingClientRect().top,
  );
  expect(dormantJumpBottom).toBeLessThanOrEqual(dormantComposerTop);
  await dormantJumpLatest.click();
  await expect(page.getByText('Dormant latest')).toBeVisible();
  await expect(page.locator('.session-page')).not.toHaveAttribute(
    'data-tail-pending',
  );
  await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem('pi-dashboard-composer-draft:session-loading'),
      ),
    )
    .toBe('Draft survives navigation and refresh');
  await page.getByRole('button', { name: 'Open agent list' }).click();
  await page
    .getByRole('complementary', { name: 'Agents and threads' })
    .getByRole('button', { name: 'Loaded shell ready' })
    .click();
  await expect(page).toHaveURL(/\/sessions\/session-loading$/u);
  await expect(page.getByLabel('Message Pi')).toContainText(
    'Draft survives navigation and refresh',
  );

  await page.reload();
  await expect(page.getByLabel('Message Pi')).toContainText(
    'Draft survives navigation and refresh',
  );
});

test('delayed command completion does not scroll a destination session', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.addInitScript(() =>
    localStorage.setItem('pi-dashboard-token', 'test-token'),
  );
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  const metadata = (id: string, title: string) => ({
    id,
    file: '',
    cwd: '/tmp',
    title,
    updatedAt: Date.now(),
  });
  const entries = (title: string) => [
    ...Array.from({ length: 90 }, (_, index) => ({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `${title} history ${index}` }],
      },
    })),
    {
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `${title} latest` }],
      },
    },
  ];
  await installDashboardBootstrap(
    page,
    {
      serverId: 'dashboard-delayed-command',
      revision: 1,
      cursor: 1,
      runtimes: [
        {
          runtimeId: 'runtime-source',
          ownership: 'external',
          pid: 1,
          cwd: '/tmp',
          liveState: 'idle',
          online: true,
          session: {
            id: 'session-source',
            title: 'Source session',
            entries: [],
          },
          model: { provider: 'test', model: 'text', supportsImages: false },
        },
      ],
      workspaces: [],
      sessions: [
        metadata('session-source', 'Source session'),
        metadata('session-destination', 'Destination session'),
      ],
      unread: [],
    },
    {
      sessionSnapshots: {
        'session-source': {
          metadata: metadata('session-source', 'Source session'),
          entries: entries('Source'),
          entriesComplete: true,
          serverId: 'dashboard-delayed-command',
          cursor: 1,
          active: {
            messages: [],
            tools: [],
            delegates: [],
            truncated: false,
          },
          completeThroughCursor: true,
        },
        'session-destination': {
          metadata: metadata('session-destination', 'Destination session'),
          entries: entries('Destination'),
          entriesComplete: true,
          serverId: 'dashboard-delayed-command',
          cursor: 1,
          active: {
            messages: [],
            tools: [],
            delegates: [],
            truncated: false,
          },
          completeThroughCursor: true,
        },
      },
    },
  );
  let commandRequested = false;
  let commandCompleted = false;
  let releaseCommand!: () => void;
  const commandReleased = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  await page.route('**/trpc/runtimeCommand', async (route) => {
    const input = dashboardTrpcInput(route.request());
    const command = input.command as Record<string, unknown> | undefined;
    commandRequested = true;
    await commandReleased;
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        runtimeId: input.runtimeId,
        commandId: command?.id,
        status: 'completed',
        result: { accepted: true },
      }),
    });
    commandCompleted = true;
  });

  await page.goto('/sessions/session-source');
  const composer = page.getByLabel('Message Pi');
  await expect(composer).toBeVisible();
  await composer.fill('Delayed command');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => commandRequested).toBe(true);

  await page.getByRole('button', { name: 'Open agent list' }).click();
  const agentNav = page.getByRole('complementary', {
    name: 'Agents and threads',
  });
  await agentNav
    .getByRole('button', { name: /Destination session ready/ })
    .click();
  await expect(page).toHaveURL(/\/sessions\/session-destination$/u);
  await expect(page.getByText('Destination latest')).toBeVisible();
  await expect(page.locator('.session-page')).not.toHaveAttribute(
    'data-tail-pending',
  );
  await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(1);
  await transcriptScroll(page).evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    element.scrollTop = 0;
  });
  const destinationScrollTop = await transcriptScroll(page).evaluate(
    (element) => element.scrollTop,
  );
  expect(destinationScrollTop).toBe(0);

  releaseCommand();
  await expect.poll(() => commandCompleted).toBe(true);
  await expect
    .poll(() => transcriptScroll(page).evaluate((element) => element.scrollTop))
    .toBe(destinationScrollTop);
});

test('live transport reconnects without HTTP polling or stale rollback', async ({
  page,
}) => {
  let usageRequests = 0;
  await page.addInitScript(() => {
    localStorage.setItem('pi-dashboard-token', 'test-token');
    type Stream = {
      controller?: ReadableStreamDefaultController<Uint8Array>;
      emit(value: unknown): void;
      close(): void;
      response: Response;
    };
    const streams: Stream[] = [];
    let nextCursor = 0;
    let reconnectSnapshotPending = false;
    const originalFetch = window.fetch.bind(window);
    const frame = (id: string, data: string) => `id: ${id}\ndata: ${data}\n\n`;
    const generationSnapshot = (generation: number) => ({
      serverId: `server-${generation}`,
      revision: 1,
      cursor: nextCursor,
      runtimes: [],
      workspaces: [
        {
          id: `workspace-${generation}`,
          name: `Live generation ${generation}`,
          path: '/tmp',
          canonicalPath: '/tmp',
          source: 'directory',
          active: false,
        },
      ],
      sessions: [],
      unread: [
        {
          id: `generation-${generation}`,
          kind: 'settled',
          title: `Live generation ${generation}`,
          body: 'Generation marker',
          createdAt: generation,
        },
      ],
    });
    const streamRecord = (value: {
      type?: string;
      snapshot?: Record<string, unknown>;
      runtimeId?: string;
      event?: unknown;
    }) => {
      const malformedSnapshot =
        value.type === 'snapshot' &&
        Array.isArray(value.snapshot?.runtimes) &&
        value.snapshot.runtimes.some(
          (runtime) =>
            !runtime ||
            typeof runtime !== 'object' ||
            !('runtimeId' in runtime),
        );
      const cursor = malformedSnapshot ? nextCursor : ++nextCursor;
      if (value.type === 'snapshot') {
        const snapshot = { ...value.snapshot, cursor };
        return {
          type: 'snapshot',
          sequence: cursor,
          snapshot: { snapshot, cursor },
        };
      }
      return {
        type: 'shell-event',
        sequence: cursor,
        domain: 'invalidation',
        revision: cursor,
        data: { refresh: true },
      };
    };
    const createStream = (): Stream => {
      const stream = {
        response: undefined as unknown as Response,
        emit(value: unknown) {
          try {
            stream.controller?.enqueue(
              new TextEncoder().encode(
                frame(
                  `shell-${nextCursor}`,
                  JSON.stringify(streamRecord(value)),
                ),
              ),
            );
          } catch {
            /* stale test streams are intentionally inert after close */
          }
        },
        close() {
          reconnectSnapshotPending = true;
          try {
            stream.controller?.error(new TypeError('network interrupted'));
          } catch {
            /* stale test streams are already disconnected */
          }
        },
      } as Stream;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.controller = controller;
          controller.enqueue(
            new TextEncoder().encode(
              'event: connected\ndata: {"reconnectAfterInactivityMs":60000}\n\n',
            ),
          );
        },
      });
      stream.response = new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
      streams.push(stream);
      return stream;
    };
    window.fetch = async (input, init) => {
      const target =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!target.includes('/trpc/shellSubscribe'))
        return originalFetch(input, init);
      const stream = createStream();
      if (streams.length === 1 || reconnectSnapshotPending) {
        reconnectSnapshotPending = false;
        stream.emit({
          type: 'snapshot',
          snapshot: generationSnapshot(streams.length),
        });
      }
      return stream.response;
    };
    Object.assign(window, {
      dashboardLiveTest: {
        count: () => streams.length,
        current: () => streams.at(-1),
        first: () => streams[0],
        forceReplayGap: () => streams.at(-1)?.close(),
        suspendAndResume: () => {
          const originalNow = Date.now;
          let now = originalNow();
          Date.now = () => now;
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
          });
          document.dispatchEvent(new Event('visibilitychange'));
          now += 16_000;
          reconnectSnapshotPending = true;
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'visible',
          });
          document.dispatchEvent(new Event('visibilitychange'));
          Date.now = originalNow;
          Reflect.deleteProperty(document, 'visibilityState');
        },
      },
    });
  });
  await page.route('**/api/usage', async (route) => {
    usageRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await installDashboardBootstrap(page, {
    serverId: 'server-1',
    revision: 1,
    cursor: 1,
    runtimes: [],
    workspaces: [
      {
        id: 'workspace-1',
        name: 'Live generation 1',
        path: '/tmp',
        canonicalPath: '/tmp',
        source: 'directory',
        active: false,
      },
    ],
    sessions: [],
    unread: [
      {
        id: 'generation-1',
        kind: 'settled',
        title: 'Live generation 1',
        body: 'Generation marker',
        createdAt: 1,
      },
    ],
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Pick a thread to continue' }),
  ).toBeVisible();
  await expect.poll(() => usageRequests).toBeGreaterThan(0);
  expect(usageRequests).toBe(1);
  const initialUsageRequests = usageRequests;
  const streamsBeforeResume = await page.evaluate(() =>
    (
      window as unknown as { dashboardLiveTest: { count(): number } }
    ).dashboardLiveTest.count(),
  );
  await page.evaluate(() => {
    (
      window as unknown as {
        dashboardLiveTest: { suspendAndResume(): void };
      }
    ).dashboardLiveTest.suspendAndResume();
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            dashboardLiveTest: { count(): number };
          }
        ).dashboardLiveTest.count(),
      ),
    )
    .toBeGreaterThan(streamsBeforeResume);
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.evaluate(() => {
    (
      window as unknown as {
        dashboardLiveTest: { current(): { emit(value: unknown): void } };
      }
    ).dashboardLiveTest
      .current()
      .emit({
        type: 'snapshot',
        snapshot: {
          serverId: 'server-1',
          revision: 2,
          runtimes: [],
          workspaces: [],
          sessions: [],
          unread: [],
        },
      });
  });
  await page.waitForTimeout(150);
  expect(usageRequests).toBe(initialUsageRequests);
  await page.evaluate(() => {
    (
      window as unknown as {
        dashboardLiveTest: { current(): { close(): void } };
      }
    ).dashboardLiveTest
      .current()
      .close();
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            dashboardLiveTest: { count(): number };
          }
        ).dashboardLiveTest.count(),
      ),
    )
    .toBeGreaterThan(1);
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(usageRequests).toBe(initialUsageRequests);
  await page.waitForTimeout(200);
  await page.goto('/projects');
  await expect(page.getByText(/Live generation \d+/)).toBeVisible();
  const streamsBeforeReplayGap = await page.evaluate(() =>
    (
      window as unknown as { dashboardLiveTest: { count(): number } }
    ).dashboardLiveTest.count(),
  );
  await page.evaluate(() => {
    (
      window as unknown as { dashboardLiveTest: { forceReplayGap(): void } }
    ).dashboardLiveTest.forceReplayGap();
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { dashboardLiveTest: { count(): number } }
        ).dashboardLiveTest.count(),
      ),
    )
    .toBeGreaterThan(streamsBeforeReplayGap);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as {
        dashboardLiveTest: { first(): { emit(value: unknown): void } };
      }
    ).dashboardLiveTest
      .first()
      .emit({
        type: 'snapshot',
        snapshot: {
          serverId: 'server-1',
          revision: 99,
          runtimes: [],
          projects: [
            {
              id: 'stale',
              title: 'ROLLED BACK',
              rootPath: '/tmp',
              maxParallelRuns: 1,
              status: 'active',
              updatedAt: 99,
              activeRunCount: 0,
            },
          ],
          sessions: [],
          unread: [
            {
              id: 'stale',
              kind: 'settled',
              title: 'ROLLED BACK',
              body: 'Stale generation marker',
              createdAt: 99,
            },
          ],
        },
      });
  });
  await page.goto('/projects');
  await expect(page.getByText(/Live generation \d+/)).toBeVisible();
  await expect(page.getByText('ROLLED BACK')).toHaveCount(0);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Pick a thread to continue' }),
  ).toBeVisible();
});

test('dense mobile session keeps conversation and activity readable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.addInitScript(() => {
    localStorage.setItem('pi-dashboard-token', 'test-token');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) =>
          sessionStorage.setItem('copied-assistant-message', text),
      },
    });
    let cursor = 1;
    let initialSessionRequest = true;
    const originalFetch = window.fetch.bind(window);
    const stream = {
      controller: undefined as
        | ReadableStreamDefaultController<Uint8Array>
        | undefined,
      response: undefined as unknown as Response,
      emit(value: { runtimeId?: string; event?: unknown }) {
        const next = ++cursor;
        stream.controller?.enqueue(
          new TextEncoder().encode(
            `id: session-${next}\ndata: ${JSON.stringify({
              type: 'session-event',
              sequence: next,
              sessionId: 's1',
              runtimeId: value.runtimeId,
              event: value.event,
            })}\n\n`,
          ),
        );
      },
    };
    window.fetch = async (input, init) => {
      const target =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!target.includes('/trpc/sessionSubscribe'))
        return originalFetch(input, init);
      if (initialSessionRequest) {
        initialSessionRequest = false;
        return originalFetch(input, init);
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.controller = controller;
          controller.enqueue(
            new TextEncoder().encode(
              'event: connected\ndata: {"reconnectAfterInactivityMs":60000}\n\n',
            ),
          );
          controller.enqueue(
            new TextEncoder().encode(
              'id: session-caught-up\ndata: {"type":"caught-up","sequence":1}\n\n',
            ),
          );
        },
      });
      stream.response = new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      });
      Object.assign(window, { dashboardTestSocket: stream });
      return stream.response;
    };
  });
  await page.route('**/api/usage', async (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await installDashboardBootstrap(page, {
    serverId: 'dashboard-dense-mobile',
    revision: 1,
    cursor: 1,
    runtimes: [
      {
        runtimeId: 'r1',
        ownership: 'external',
        pid: 1,
        cwd: '/tmp',
        liveState: 'idle',
        session: { id: 's1', entries: [] },
        model: {
          provider: 'test',
          model: 'vision',
          supportsImages: true,
        },
        contextUsage: {
          tokens: 136_000,
          contextWindow: 272_000,
          percent: 50,
        },
      },
    ],
    workspaces: [],
    sessions: [],
    unread: [],
  });
  let commandContentType = '';
  let commandBody = '';
  await page.route(/\/api\/runtimes\/r1\/command$/, async (route) => {
    commandContentType = route.request().headers()['content-type'] ?? '';
    commandBody = route.request().postData() ?? '';
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.route('**/trpc/sessionSubscribe*', async (route) => {
    await route.fulfill({
      contentType: 'text/event-stream',
      body: trpcSseData(
        {
          type: 'snapshot',
          sequence: 1,
          snapshot: {
            metadata: {
              id: 's1',
              file: '',
              cwd: '/tmp',
              updatedAt: Date.now(),
            },
            entries: [
              ...Array.from({ length: 90 }, (_, index) => ({
                type: 'message',
                message: {
                  role: 'user',
                  content: [
                    { type: 'text', text: `Earlier message ${index + 1}` },
                  ],
                },
              })),
              {
                type: 'compaction',
                summary:
                  '## Compaction checkpoint\nPreserved the dashboard task.',
                tokensBefore: 232_000,
              },
              {
                type: 'custom',
                customType: 'lean-todo',
                data: {
                  kind: 'snapshot',
                  state: {
                    tasks: [
                      { id: 'T1', text: 'Verify dashboard', status: 'todo' },
                    ],
                  },
                },
              },
              {
                type: 'custom',
                customType: 'lean-todo',
                data: {
                  kind: 'snapshot',
                  state: {
                    tasks: [
                      { id: 'T1', text: 'Verify dashboard', status: 'doing' },
                    ],
                  },
                },
              },
              {
                type: 'model_change',
                provider: 'openai',
                modelId: 'gpt-5.6-sol',
              },
              { type: 'thinking_level_change', thinkingLevel: 'medium' },
              {
                type: 'custom_message',
                customType: 'background-terminal-result',
                display: true,
                content: 'Background build completed.',
                details: {
                  title: 'Dashboard build',
                  status: 'done',
                  exitCode: 0,
                  duration: 2400,
                },
              },
              {
                type: 'custom',
                customType: 'private-state:v1',
                data: { bytes: 12 },
              },
              {
                type: 'custom_message',
                customType: 'private-context',
                display: false,
                content: 'Do not render this context.',
              },
              {
                type: 'message',
                message: {
                  role: 'user',
                  content: [
                    { type: 'text', text: 'Focus on mobile readability.' },
                  ],
                  timestamp: 100,
                },
              },
              {
                type: 'custom',
                customType: 'steering-message',
                data: { timestamp: 100, text: 'Focus on mobile readability.' },
              },
              {
                type: 'message',
                message: {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: '**Check** the [dashboard](https://example.com).',
                    },
                  ],
                },
              },
              {
                type: 'message',
                message: {
                  role: 'assistant',
                  timestamp: '2026-08-09T12:34:00.000Z',
                  content: [
                    {
                      type: 'thinking',
                      thinking: 'Checking the available mobile width.',
                    },
                    { type: 'text', text: 'Checking the mobile transcript.' },
                    {
                      type: 'toolCall',
                      id: 'call-1',
                      name: 'read',
                      arguments: { path: 'src/App.tsx' },
                    },
                  ],
                },
              },
              {
                type: 'message',
                message: {
                  role: 'toolResult',
                  toolCallId: 'call-1',
                  content: [{ type: 'text', text: 'ok' }],
                  isError: false,
                },
              },
              {
                type: 'message',
                message: {
                  role: 'assistant',
                  content: [
                    { type: 'text', text: 'Checking the failed command.' },
                    {
                      type: 'toolCall',
                      id: 'call-2',
                      name: 'bash',
                      arguments: {
                        command: 'false',
                        description:
                          'Run the expected failing command while preserving the complete mobile activity layout',
                      },
                    },
                  ],
                },
              },
              {
                type: 'message',
                message: {
                  role: 'toolResult',
                  toolCallId: 'call-2',
                  content: [{ type: 'text', text: 'Command failed' }],
                  isError: true,
                },
              },
              {
                type: 'message',
                message: {
                  role: 'assistant',
                  timestamp: '2026-08-09T12:35:00.000Z',
                  content: [
                    {
                      type: 'text',
                      text: 'Result: **ready** with `inline code`.',
                    },
                    {
                      type: 'text',
                      text: 'Deployment resumes automatically.',
                    },
                  ],
                },
              },
            ],
            serverId: 'dashboard-dense-mobile',
            cursor: 1,
            active: {
              messages: [],
              tools: [],
              delegates: [],
              truncated: false,
            },
            completeThroughCursor: true,
          },
        },
        'session-s1',
      ),
    });
  });
  await page.goto('/sessions/s1');
  const steeringMessage = page.locator('.message-steering');
  await expect(steeringMessage).toContainText('Focus on mobile readability.');
  await expect(steeringMessage.locator('.transcript-time')).toBeVisible();
  await expect(steeringMessage.locator('.message-delivery-mode')).toHaveCount(
    0,
  );
  const steeringColors = await steeringMessage.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    border: getComputedStyle(element).borderLeftColor,
  }));
  const ordinaryUserBackground = await page
    .locator('.message-user:not(.message-steering)')
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(steeringColors.background).toBe(ordinaryUserBackground);
  expect(steeringColors.border).not.toBe(steeringColors.background);
  await expect(page.getByText('Check', { exact: true })).toBeVisible();
  const userLink = page.getByRole('link', { name: 'dashboard' });
  await expect(userLink).toHaveAttribute('href', 'https://example.com');
  await expect(userLink).toHaveAttribute('target', '_blank');
  await expect(page.locator('.session-status')).toContainText('ready');
  const compactHeader = await page
    .locator('.session-heading')
    .evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      text: element.textContent ?? '',
    }));
  expect(compactHeader.height).toBeGreaterThanOrEqual(44);
  expect(compactHeader.height).toBeLessThanOrEqual(52);
  expect(compactHeader.text).not.toContain('/tmp');
  expect(compactHeader.text).not.toContain('test/');
  await expect(page.getByText('inline code', { exact: true })).toBeVisible();
  await expect(page.locator('.message-meta, .message-role')).toHaveCount(0);
  await expect(page.locator('.tool-step-time')).toHaveCount(1);
  await expect(
    page.locator('.message-bubble-accessories .transcript-time').first(),
  ).toBeVisible();
  const fullWidthGeometry = await page.evaluate(() => {
    const transcript = document.querySelector('.transcript');
    const message = document.querySelector('.message-bubble');
    const composer = document.querySelector('.composer');
    if (!transcript || !message || !composer)
      throw new Error('Transcript surfaces missing');
    return {
      transcript: transcript.getBoundingClientRect().width,
      message: message.getBoundingClientRect().width,
      composer: composer.getBoundingClientRect().width,
    };
  });
  expect(
    Math.abs(fullWidthGeometry.message - fullWidthGeometry.transcript),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(fullWidthGeometry.composer - fullWidthGeometry.transcript),
  ).toBeLessThanOrEqual(1);
  const finalAssistantParagraphs = page
    .locator('.message-assistant')
    .filter({ hasText: 'Deployment resumes automatically.' })
    .locator('.markdown > p');
  await expect(finalAssistantParagraphs).toHaveCount(2);
  const paragraphBoxes = await finalAssistantParagraphs.evaluateAll(
    (paragraphs) =>
      paragraphs.map((paragraph) => {
        const bounds = paragraph.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom };
      }),
  );
  expect(paragraphBoxes[1]?.top).toBeGreaterThan(
    paragraphBoxes[0]?.bottom ?? 0,
  );
  const assistantFlow = await page
    .locator('.message-assistant')
    .filter({ hasText: 'Deployment resumes automatically.' })
    .evaluate((message) => {
      const accessory = message.querySelector<HTMLElement>(
        '.message-bubble-accessories',
      );
      const markdown = message.querySelector<HTMLElement>('.markdown');
      if (!accessory || !markdown)
        throw new Error('Assistant message geometry missing');
      const accessoryRect = accessory.getBoundingClientRect();
      const lineRects = Array.from(markdown.querySelectorAll('p')).flatMap(
        (paragraph) => {
          const range = document.createRange();
          range.selectNodeContents(paragraph);
          return Array.from(range.getClientRects()).map((rect) => ({
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
          }));
        },
      );
      return {
        accessoryLeft: accessoryRect.left,
        accessoryBottom: accessoryRect.bottom,
        overflowX: getComputedStyle(markdown).overflowX,
        alongside: lineRects.filter(
          (line) =>
            line.top < accessoryRect.bottom && line.bottom > accessoryRect.top,
        ),
        below: lineRects.filter((line) => line.top >= accessoryRect.bottom - 1),
      };
    });
  expect(assistantFlow.overflowX).toBe('visible');
  expect(assistantFlow.alongside.length).toBeGreaterThan(0);
  expect(
    assistantFlow.alongside.every(
      (line) => line.right <= assistantFlow.accessoryLeft + 1,
    ),
  ).toBe(true);
  expect(
    assistantFlow.below.some(
      (line) => line.right > assistantFlow.accessoryLeft + 1,
    ),
  ).toBe(true);
  await expect(
    page.getByText('Context compacted', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('232k tokens', { exact: true })).toBeVisible();
  await expect(page.getByText(/Tasks · T1 added · 1 waiting/)).toBeVisible();
  await expect(page.getByText(/Tasks · T1 started · 1 active/)).toBeVisible();
  await expect(
    page.getByText('Model → openai/gpt-5.6-sol · thinking medium'),
  ).toBeVisible();
  await expect(
    page.getByText(/Background command finished · Dashboard build · 2s/),
  ).toBeVisible();
  await expect(page.getByText('private-state:v1')).toHaveCount(0);
  await expect(page.getByText('Do not render this context.')).toHaveCount(0);
  await page.getByText('Context compacted', { exact: true }).click();
  await expect(page.getByText('Compaction checkpoint')).toBeVisible();
  await page.evaluate(() => {
    const target = document;
    if (!document.querySelector('.agent-nav-handle'))
      throw new Error('agent drawer handle missing');
    const touch = (type: string, x: number) =>
      target.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          changedTouches: [
            new Touch({
              identifier: 1,
              target,
              clientX: x,
              clientY: 300,
            }),
          ],
        }),
      );
    touch('touchstart', 2);
    touch('touchend', 86);
  });
  await expect(page.locator('.agent-nav-drawer.open')).toBeVisible();
  const threadRow = page
    .locator('.agent-nav-drawer.open .agent-thread-row')
    .first();
  const threadCopyRightInset = await threadRow.evaluate((row) => {
    const copy = row.querySelector('.agent-thread-copy');
    const link = row.querySelector('button[data-row-density]');
    if (!copy || !link) throw new Error('Agent thread row geometry missing');
    const styles = getComputedStyle(link);
    return {
      actual:
        row.getBoundingClientRect().right - copy.getBoundingClientRect().right,
      expected:
        row.getBoundingClientRect().right -
        link.getBoundingClientRect().right +
        Number.parseFloat(styles.paddingRight) +
        Number.parseFloat(styles.borderRightWidth),
    };
  });
  expect(threadCopyRightInset.actual).toBeCloseTo(
    threadCopyRightInset.expected,
    1,
  );
  await threadRow.click();
  await expect(page.locator('.agent-nav-drawer.open')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open transcript outline' }).click();
  const outline = page.getByRole('dialog', { name: 'Transcript outline' });
  await expect(outline).toBeVisible();
  await swipe(outline, { dx: 44 });
  await expect(outline).toBeVisible();
  await swipe(outline, { dx: 104, dy: 8 });
  await expect(outline).toHaveCount(0);
  await page.getByRole('button', { name: 'Open transcript outline' }).click();
  const reopenedOutline = page.getByRole('dialog', {
    name: 'Transcript outline',
  });
  const steeringOutlineItem = reopenedOutline.getByRole('button', {
    name: /^Steering · Focus on mobile readability\./u,
  });
  await expect(steeringOutlineItem).toHaveClass(/outline-steering/u);
  const outlineItemLayout = await steeringOutlineItem.evaluate((item) => {
    const label = item.querySelector('span');
    const time = item.querySelector('.transcript-outline-time');
    const body = item.closest('.surface-drawer-body');
    if (!label || !time || !body)
      throw new Error('Transcript outline item layout missing');
    const labelStyle = getComputedStyle(label);
    return {
      bodyFlexGrow: getComputedStyle(body).flexGrow,
      labelOverflow: labelStyle.overflow,
      labelWhiteSpace: labelStyle.whiteSpace,
      timeFloat: getComputedStyle(time).cssFloat,
    };
  });
  expect(outlineItemLayout).toEqual({
    bodyFlexGrow: '0',
    labelOverflow: 'visible',
    labelWhiteSpace: 'normal',
    timeFloat: 'inline-end',
  });
  await reopenedOutline
    .getByRole('button', { name: 'Earlier message 1', exact: true })
    .click();
  await expect(reopenedOutline).toHaveCount(0);
  await transcriptScroll(page).evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  const jumpLatest = page.getByRole('button', {
    name: 'Jump to latest transcript activity',
  });
  await expect(jumpLatest).toBeVisible();
  const jumpGeometry = await jumpLatest.evaluate((button) => {
    const buttonRect = button.getBoundingClientRect();
    const composerRect = document
      .querySelector('.composer')
      ?.getBoundingClientRect();
    return {
      width: buttonRect.width,
      height: buttonRect.height,
      rightGap: window.innerWidth - buttonRect.right,
      bottom: buttonRect.bottom,
      composerTop: composerRect?.top,
      borderRadius: getComputedStyle(button).borderRadius,
    };
  });
  expect(jumpGeometry.borderRadius).toBe('50%');
  expect(jumpGeometry.width).toBeCloseTo(48, 1);
  expect(jumpGeometry.height).toBeCloseTo(48, 1);
  expect(jumpGeometry.rightGap).toBeCloseTo(13, 1);
  expect(jumpGeometry.bottom).toBeLessThan(jumpGeometry.composerTop ?? 0);
  await jumpLatest.click();
  await expect(jumpLatest).toHaveCount(0);
  await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(1);
  const failedActivity = page
    .locator('.tool-detail.step-failed')
    .filter({ hasText: 'Run the expected failing command' })
    .first();
  await expect(failedActivity).toBeVisible();
  const failedActivityGroup = failedActivity;
  const failedToolSummary = failedActivity.locator(
    ':scope > summary.tool-step',
  );
  await failedToolSummary.click();
  const describedAction = failedActivity.locator('.tool-name-described');
  const commandDescription =
    'Run the expected failing command while preserving the complete mobile activity layout';
  await expect(describedAction).toHaveText(commandDescription);
  await expect(
    failedActivityGroup.locator('.tool-command-description'),
  ).toHaveText(commandDescription);
  const commandSections = await failedActivityGroup.evaluate((group) => {
    const input = group.querySelector('.tool-command-input');
    const result = group.querySelector('.tool-terminal-result');
    if (!input || !result)
      throw new Error('command inspector sections missing');
    const inputRect = input.getBoundingClientRect();
    const resultRect = result.getBoundingClientRect();
    return {
      gap: resultRect.top - inputRect.bottom,
      inputLeft: inputRect.left,
      resultLeft: resultRect.left,
    };
  });
  expect(commandSections.gap).toBeCloseTo(0, 1);
  expect(commandSections.inputLeft).toBeCloseTo(commandSections.resultLeft, 1);
  const describedActionLayout = await describedAction.evaluate((element) => {
    const row = element.closest('.tool-step');
    if (!row) throw new Error('described activity row missing');
    const style = getComputedStyle(element);
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      right: element.getBoundingClientRect().right,
      rowRight: row.getBoundingClientRect().right,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });
  expect(describedActionLayout.scrollWidth).toBeGreaterThan(
    describedActionLayout.clientWidth,
  );
  expect(describedActionLayout.right).toBeLessThanOrEqual(
    describedActionLayout.rowRight,
  );
  expect(describedActionLayout).toMatchObject({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
  const failedExpandedDot = failedActivityGroup.locator(
    ':scope > summary.tool-step .tool-step-dot',
  );
  await expect(failedExpandedDot).toHaveText('!');
  await failedToolSummary.click();
  const activity = page
    .locator('.tool-detail')
    .filter({ hasText: 'src/App.tsx' })
    .first();
  await expect(activity).toBeVisible();
  await expect(page.getByLabel('Message Pi')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Attach images' }),
  ).toBeVisible();
  const imageInput = page.getByLabel('Choose images');
  await scrollTranscript(page, Number.MAX_SAFE_INTEGER);
  await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(1);
  const composerHeightBeforeAttachment = await page
    .locator('.composer')
    .evaluate((element) => element.getBoundingClientRect().height);
  await imageInput.setInputFiles({
    name: 'picker.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71]),
  });
  await expect(page.getByAltText('picker.png')).toBeVisible();
  await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(1);
  const attachmentLayout = await page.evaluate(() => {
    const composer = document.querySelector('.composer');
    const previews = document.querySelector('.composer-previews');
    const controlLayer = document.querySelector('.session-control-layer');
    const transcriptScrollElement = document.querySelector(
      '.session-transcript-scroll',
    );
    const sessionPage = document.querySelector('.session-page');
    if (
      !composer ||
      !previews ||
      !controlLayer ||
      !transcriptScrollElement ||
      !sessionPage
    )
      throw new Error('Composer layout not found');
    const composerRect = composer.getBoundingClientRect();
    const previewsRect = previews.getBoundingClientRect();
    return {
      composerHeight: composerRect.height,
      previewsTop: previewsRect.top,
      previewsBottom: previewsRect.bottom,
      composerTop: composerRect.top,
      composerBottom: composerRect.bottom,
      controlHeight: controlLayer.getBoundingClientRect().height,
      controlTop: controlLayer.getBoundingClientRect().top,
      transcriptBottom: transcriptScrollElement.getBoundingClientRect().bottom,
      pagePaddingBottom: Number.parseFloat(
        getComputedStyle(sessionPage).paddingBottom,
      ),
    };
  });
  expect(attachmentLayout.composerHeight).toBeGreaterThan(
    composerHeightBeforeAttachment,
  );
  expect(attachmentLayout.previewsTop).toBeGreaterThanOrEqual(
    attachmentLayout.composerTop,
  );
  expect(attachmentLayout.previewsBottom).toBeLessThanOrEqual(
    attachmentLayout.composerBottom,
  );
  expect(attachmentLayout.pagePaddingBottom).toBe(0);
  expect(attachmentLayout.transcriptBottom).toBeLessThanOrEqual(
    attachmentLayout.controlTop + 1,
  );
  expect(
    attachmentLayout.controlTop - attachmentLayout.transcriptBottom,
  ).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Remove picker.png' }).click();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([1])], 'paste.webp', { type: 'image/webp' }),
    );
    document.querySelector('[contenteditable="true"]')?.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  });
  await expect(page.getByAltText('paste.webp')).toBeVisible();
  await page.evaluate(() => {
    const composer = document.querySelector('.composer');
    if (!composer) throw new Error('Composer not found');
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([2])], 'drop.jpeg', { type: 'image/jpeg' }),
    );
    composer.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect(page.getByAltText('drop.jpeg')).toBeVisible();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => commandBody).toContain('"text":""');
  expect(commandContentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(commandBody).toContain('name="command"');
  expect(commandBody).toContain('name="images"');
  expect(commandBody).toContain('paste.webp');
  expect(commandBody).toContain('drop.jpeg');
  await expect(page.getByAltText('paste.webp')).toHaveCount(0);
  await expect(page.getByLabel('Context window 50% [136k/272k]')).toBeVisible();
  expect(await transcriptGap(page)).toBeLessThanOrEqual(1);
  expect(await page.locator('.mobile-bottom-nav')).toHaveCount(0);
  const composerViewportLayout = await page.evaluate(() => {
    const composer = document
      .querySelector('.composer')
      ?.getBoundingClientRect();
    return composer
      ? {
          bottom: composer.bottom,
          viewport: window.visualViewport?.height ?? window.innerHeight,
        }
      : undefined;
  });
  expect(composerViewportLayout?.bottom).toBeLessThanOrEqual(
    (composerViewportLayout?.viewport ?? 0) + 1,
  );
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('Visual Viewport unavailable');
    Object.defineProperty(viewport, 'height', {
      configurable: true,
      value: window.innerHeight - 240,
    });
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect
    .poll(() =>
      page.locator('.session-page').evaluate((element) => {
        const viewport = window.visualViewport;
        const visibleBottom = viewport
          ? viewport.offsetTop + viewport.height
          : window.innerHeight;
        return (
          visibleBottom -
          element.getBoundingClientRect().top -
          Number.parseFloat(
            getComputedStyle(element).getPropertyValue(
              '--session-viewport-height',
            ),
          )
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  const keyboardComposerBottom = await page
    .locator('.composer')
    .evaluate((element) => element.getBoundingClientRect().bottom);
  const keyboardVisibleBottom = (composerViewportLayout?.viewport ?? 0) - 240;
  expect(keyboardComposerBottom).toBeLessThanOrEqual(keyboardVisibleBottom + 1);
  expect(keyboardVisibleBottom - keyboardComposerBottom).toBeLessThanOrEqual(8);
  const documentScroll = await page.evaluate(() => {
    const before = window.scrollY;
    window.scrollBy(0, -48);
    window.visualViewport?.dispatchEvent(new Event('scroll'));
    return { before, after: window.scrollY };
  });
  expect(documentScroll.after).toBe(documentScroll.before);
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    Reflect.deleteProperty(viewport, 'height');
    viewport.dispatchEvent(new Event('resize'));
  });
  await transcriptScroll(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(activity).toBeVisible();
  const expandedAction = activity.locator(':scope > summary.tool-step');
  await expect(
    expandedAction.locator('.tool-name').getByText('Reading'),
  ).toBeVisible();
  const expandedStepDot = expandedAction.locator('.tool-step-dot');
  await expect(expandedStepDot).toBeVisible();
  expect(
    await expandedStepDot.evaluate(
      (dot) => getComputedStyle(dot, '::before').backgroundColor,
    ),
  ).not.toBe('rgba(0, 0, 0, 0)');
  const thinkingTime = page.locator('.thinking-time');
  await expect(thinkingTime).toBeVisible();
  const thinkingLayout = await thinkingTime.evaluate((time) => {
    const blob = time.closest('.transcript-thinking-blob');
    const firstParagraph = blob?.querySelector('.markdown > p');
    if (!blob || !firstParagraph) throw new Error('Thinking layout missing');
    const timeRect = time.getBoundingClientRect();
    const blobRect = blob.getBoundingClientRect();
    const paragraphRect = firstParagraph.getBoundingClientRect();
    return {
      topDifference: Math.abs(timeRect.top - paragraphRect.top),
      paragraphTopInset: paragraphRect.top - blobRect.top,
      blobBackgroundImage: getComputedStyle(blob).backgroundImage,
      timestampBackgroundImage: getComputedStyle(time).backgroundImage,
    };
  });
  expect(thinkingLayout.topDifference).toBeLessThanOrEqual(2);
  expect(thinkingLayout.paragraphTopInset).toBeLessThanOrEqual(8);
  expect(thinkingLayout.blobBackgroundImage).toContain('linear-gradient');
  expect(thinkingLayout.timestampBackgroundImage).toBe('none');
  const timestampRights = await page
    .locator(
      '.message-bubble-accessories .transcript-time:visible, .tool-detail .tool-step-time:visible',
    )
    .evaluateAll((timestamps) =>
      timestamps.map((timestamp) => timestamp.getBoundingClientRect().right),
    );
  expect(timestampRights.length).toBeGreaterThanOrEqual(2);
  expect(
    Math.max(...timestampRights) - Math.min(...timestampRights),
  ).toBeLessThanOrEqual(1);
  await expect(page.getByText('src/App.tsx', { exact: true })).toBeVisible();
  await page.waitForFunction(
    () =>
      (window as unknown as { dashboardTestSocket?: unknown })
        .dashboardTestSocket !== undefined,
  );
  const emitAssistant = async (content: unknown[]) =>
    page.evaluate((assistantContent) => {
      (
        window as unknown as {
          dashboardTestSocket: { emit(value: unknown): void };
        }
      ).dashboardTestSocket.emit({
        type: 'event',
        serverId: 'legacy',
        revision: assistantContent.length,
        runtimeId: 'r1',
        event: {
          type: 'message.updated',
          sessionId: 's1',
          message: {
            messageId: 'live-assistant-turn',
            role: 'assistant',
            content: assistantContent,
          },
        },
      });
    }, content);
  await emitAssistant([{ type: 'text', text: 'Preparing live tool.' }]);
  await expect(
    page
      .locator('.message-assistant')
      .filter({ hasText: 'Preparing live tool.' }),
  ).toHaveCount(0);
  await emitAssistant([
    { type: 'text', text: 'Preparing live tool.' },
    {
      type: 'toolCall',
      id: 'live-call',
      name: 'read',
      arguments: { path: 'src/live.ts' },
    },
  ]);
  await expect(
    page
      .locator('.message-assistant')
      .filter({ hasText: 'Preparing live tool.' }),
  ).toHaveCount(1);
  await expect(
    page.locator('.tool-detail').filter({ hasText: 'src/live.ts' }).first(),
  ).toBeVisible();
  const emitMessage = async (type: string, timestamp: number, text: string) =>
    page.evaluate(
      ({ type, timestamp, text }) => {
        (
          window as unknown as {
            dashboardTestSocket: { emit(value: unknown): void };
          }
        ).dashboardTestSocket.emit({
          type: 'event',
          serverId: 'legacy',
          revision: timestamp + (type.endsWith('finished') ? 1 : 0),
          runtimeId: 'r1',
          event: {
            type,
            sessionId: 's1',
            message: {
              messageId: `live-user-${timestamp}`,
              role: 'user',
              timestamp,
              content: [{ type: 'text', text }],
            },
          },
        });
      },
      { type, timestamp, text },
    );
  await emitMessage('message.started', 123, 'Live dashboard message');
  await expect(
    page.locator('.message-bubble').getByText('Live dashboard message'),
  ).toHaveCount(1);
  // Reload while the authenticated stream is active; the session baseline and
  // transcript projection must hydrate without relying on the old page state.
  await page.reload();
  await expect(page.locator('.session-status')).toContainText('ready');
  await expect(page.getByLabel('Message Pi')).toBeVisible();
  await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(1);
  await page.waitForFunction(
    () =>
      (window as unknown as { dashboardTestSocket?: unknown })
        .dashboardTestSocket !== undefined,
  );
  await emitMessage('message.finished', 123, 'Live dashboard message');
  await expect(
    page.locator('.message-bubble').getByText('Live dashboard message'),
  ).toHaveCount(1);
  await page.evaluate(() => {
    (
      window as unknown as {
        dashboardTestSocket: { emit(value: unknown): void };
      }
    ).dashboardTestSocket.emit({
      type: 'event',
      serverId: 'legacy',
      revision: 1000,
      runtimeId: 'r1',
      event: { type: 'agent.settled', sessionId: 's1' },
    });
  });
  await emitMessage('message.started', 321, 'Delta during settled turn');
  await expect(
    page.locator('.message-bubble').getByText('Delta during settled turn'),
  ).toBeVisible();
  await transcriptScroll(page).evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 }));
    element.scrollTop = Math.max(0, element.scrollTop - 400);
  });
  await emitMessage('message.started', 456, 'Message while reading history');
  await expect(
    page.locator('.message-bubble').getByText('Message while reading history'),
  ).toHaveCount(1);
  await expect.poll(() => transcriptGap(page)).toBeGreaterThan(120);
  const finalAssistant = page
    .locator('.message-assistant')
    .filter({ hasText: 'Deployment resumes automatically.' });
  await finalAssistant
    .getByRole('button', { name: 'Copy assistant message' })
    .click();
  await expect(
    finalAssistant.getByRole('button', { name: 'Copied assistant message' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem('copied-assistant-message'),
    ),
  ).toBe(
    'Result: **ready** with `inline code`.\n\nDeployment resumes automatically.',
  );
  expect(
    await page
      .locator('body')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});

const phase6ActionSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function phase6Capabilities() {
  return {
    version: 1,
    capabilities: [
      {
        id: 'remote-control.semantic-actions',
        version: '1',
        available: true,
      },
      { id: 'activity-groups', version: '1', available: true },
      { id: 'runtime.pause-control', version: '1', available: true },
    ],
    manifests: [
      {
        id: 'remote-control',
        version: '1',
        actions: [
          {
            id: 'session.compact',
            title: 'Compact session',
            inputSchema: {
              type: 'object',
              properties: { customInstructions: { type: 'string' } },
              additionalProperties: false,
            },
            availability: {
              requires: ['remote-control.semantic-actions'],
              liveStates: ['idle', 'working', 'waiting'],
            },
          },
          {
            id: 'runtime.abort',
            title: 'Abort run',
            inputSchema: phase6ActionSchema,
            availability: {
              requires: ['remote-control.semantic-actions'],
              liveStates: ['working', 'waiting', 'aborting'],
            },
          },
          {
            id: 'unsafe.action',
            title: 'Unsafe unavailable action',
            inputSchema: phase6ActionSchema,
            availability: { requires: ['missing-capability'] },
          },
        ],
        renderers: [],
      },
      {
        id: 'pause',
        version: '1',
        actions: [
          {
            id: 'runtime.pause',
            title: 'Pause runtime',
            inputSchema: phase6ActionSchema,
            availability: {
              requires: ['runtime.pause-control'],
              liveStates: ['idle', 'working', 'waiting'],
            },
          },
          {
            id: 'runtime.continue',
            title: 'Continue runtime',
            inputSchema: phase6ActionSchema,
            availability: {
              requires: ['runtime.pause-control'],
              liveStates: ['idle', 'working', 'waiting'],
            },
          },
        ],
        renderers: [],
      },
      {
        id: 'activity-groups',
        version: '1',
        actions: [
          {
            id: 'activity-groups.set',
            title: 'Set activity groups',
            inputSchema: {
              type: 'object',
              properties: {
                expanded: { type: 'boolean' },
                enabled: { type: 'boolean' },
              },
              minProperties: 1,
              additionalProperties: false,
            },
            availability: { requires: ['activity-groups'] },
          },
        ],
        renderers: [],
      },
    ],
  };
}

function phase6Entries() {
  return [
    ...Array.from({ length: 84 }, (_, index) => ({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `Earlier history ${index + 1}` }],
        timestamp: Date.UTC(2026, 7, 5, 18, index),
      },
    })),
    {
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Existing session request' }],
      },
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '**Considering the workspace**' },
          { type: 'text', text: 'Inspecting history' },
          {
            type: 'toolCall',
            id: 'history-read',
            name: 'read',
            arguments: { path: '/tmp/project/src/App.tsx' },
          },
        ],
      },
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'history-read',
        content: [{ type: 'text', text: 'history contents' }],
        isError: false,
      },
    },
  ];
}

function phase6Snapshot(
  overrides: {
    liveState?: string;
    workspaces?: unknown[];
    unread?: unknown[];
    extensionSurfaces?: unknown[];
    runtimes?: unknown[];
  } = {},
): import('@pi-dashboard/protocol').BrowserSnapshot {
  return {
    serverId: 'phase-six',
    revision: 1,
    cursor: 1,
    runtimes: overrides.runtimes ?? [
      {
        runtimeId: 'r1',
        ownership: 'managed',
        pid: 42,
        cwd: '/tmp/project',
        liveState: overrides.liveState ?? 'working',
        online: true,
        session: { id: 's1', entries: [] },
        model: {
          provider: 'test',
          model: 'vision',
          thinking: 'medium',
          supportsImages: true,
        },
        modelCatalog: [
          {
            provider: 'test',
            model: 'vision',
            name: 'Vision',
            supportsImages: true,
          },
          {
            provider: 'test',
            model: 'text',
            name: 'Text only',
            supportsImages: false,
          },
        ],
        thinkingLevels: ['off', 'low', 'medium', 'high'],
        composerCommands: [
          {
            name: 'compact',
            description: 'Compact the current session',
            source: 'builtin',
          },
          {
            name: 'review',
            description: 'Review changes',
            source: 'prompt',
          },
          {
            name: 'skill:browser',
            description: 'Automate a browser',
            source: 'skill',
          },
        ],
        capabilities: phase6Capabilities(),
        ...(overrides.extensionSurfaces
          ? { extensionSurfaces: overrides.extensionSurfaces }
          : {}),
      },
    ],
    workspaces: overrides.workspaces ?? [
      {
        id: 'w1',
        name: 'Project',
        path: '/tmp/project',
        canonicalPath: '/tmp/project',
        source: 'directory',
        active: true,
      },
    ],
    sessions: [
      {
        id: 's1',
        file: '/tmp/project/session.jsonl',
        cwd: '/tmp/project',
        workspaceId: 'w1',
        title: 'Existing session request',
        updatedAt: 1,
        activeRuntimeId: 'r1',
        entryCount: 87,
      },
    ],
    unread: overrides.unread ?? [
      {
        id: 'notice-1',
        kind: 'settled',
        title: 'Agent settled',
        body: 'The existing session is ready.',
        createdAt: 1,
      },
    ],
  } as import('@pi-dashboard/protocol').BrowserSnapshot;
}

function markdownActivityEntries({ blockFirst = false } = {}) {
  return [
    ...Array.from({ length: 20 }, (_, index) => ({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `Earlier transcript ${index + 1}` }],
      },
    })),
    {
      type: 'message',
      message: {
        role: 'assistant',
        timestamp: '2026-08-13T18:42:00.000Z',
        content: [
          {
            type: 'text',
            text: blockFirst
              ? '## Block-first preamble\n\n- preserve the list\n- preserve the block\n\n```ts\nconst blockFirst = true;\n```'
              : '**Review the workspace** This preamble has a [guide](https://example.com/guide) and enough ordinary text to wrap around the timestamp accessory before continuing on a full-width line below it. It keeps flowing beside the accessory for several lines so the float is genuinely tested.\n\nThe following paragraph should use the full header width and continue with enough words to make its line geometry reach the normal right boundary after the accessory ends. This proves the float has cleared rather than merely measuring a full-width block.',
          },
          {
            type: 'toolCall',
            id: 'markdown-read',
            name: 'read',
            arguments: { path: 'src/index.ts' },
          },
        ],
      },
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'markdown-read',
        content: [{ type: 'text', text: 'read complete' }],
        isError: false,
      },
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `Later transcript ${index + 1}` }],
      },
    })),
  ];
}

function repeatedActivityEntries() {
  return [
    ...Array.from({ length: 84 }, (_, index) => ({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `Earlier history ${index + 1}` }],
      },
    })),
    ...Array.from({ length: 4 }, (_, index) => [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `Activity group ${index + 1}` },
            {
              type: 'toolCall',
              id: `repeated-read-${index}`,
              name: 'read',
              arguments: { path: `/tmp/project/file-${index}.ts` },
            },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: `repeated-read-${index}`,
          content: [{ type: 'text', text: `result ${index + 1}` }],
          isError: false,
        },
      },
    ]).flat(),
    {
      type: 'message',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: Array.from(
              { length: 80 },
              (_, index) => `Trailing context ${index + 1}`,
            ).join('\n'),
          },
        ],
      },
    },
  ];
}

function phase6EditEntries(historyCount: number) {
  const oldText = Array.from(
    { length: 420 },
    (_, index) => `const oldValue${index} = ${index};`,
  ).join('\n');
  const newText = Array.from(
    { length: 420 },
    (_, index) => `const newValue${index} = ${index};`,
  ).join('\n');
  return [
    ...Array.from({ length: historyCount }, (_, index) => ({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `History ${index + 1}` }],
      },
    })),
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Applying the large edit' },
          {
            type: 'toolCall',
            id: `large-edit-${historyCount}`,
            name: 'edit',
            arguments: {
              path: 'src/large.ts',
              edits: [{ oldText, newText }],
            },
          },
        ],
      },
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: `large-edit-${historyCount}`,
        content: [{ type: 'text', text: 'updated' }],
        isError: false,
      },
    },
    {
      type: 'message',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: Array.from(
              { length: 60 },
              (_, index) => `Later transcript context ${index + 1}`,
            ).join('\n'),
          },
        ],
      },
    },
  ];
}

async function installPhase6Mocks(
  page: Page,
  options: {
    entries?: unknown[];
    snapshot?: import('@pi-dashboard/protocol').BrowserSnapshot;
  } = {},
) {
  const commands: Array<Record<string, unknown>> = [];
  const starts: Array<Record<string, unknown>> = [];
  const stops: Array<Record<string, unknown>> = [];
  const restarts: Array<Record<string, unknown>> = [];
  const initialFixture = {
    snapshot: options.snapshot ?? phase6Snapshot(),
    entries: options.entries ?? phase6Entries(),
  };
  await page.addInitScript((initial) => {
    localStorage.setItem('pi-dashboard-token', 'test-token');
    type Stream = {
      controller?: ReadableStreamDefaultController<Uint8Array>;
      close(): void;
      send(value: Record<string, unknown>): void;
    };
    const shellStreams: Stream[] = [];
    const sessionStreams: Stream[] = [];
    let shellSequence = 0;
    const sessionSequences = new Map<string, number>();
    let initialSessionRequest = true;
    let latestSnapshot = initial.snapshot;
    const originalFetch = window.fetch.bind(window);
    const trackedFrame = (id: string, value: unknown) =>
      `id: ${id}\ndata: ${JSON.stringify(value)}\n\n`;
    const createStream = (kind: 'shell' | 'session', sessionId = 's1') => {
      const nextSequence = () => {
        if (kind === 'shell') return ++shellSequence;
        const sequence = (sessionSequences.get(sessionId) ?? 0) + 1;
        sessionSequences.set(sessionId, sequence);
        return sequence;
      };
      const stream = {
        controller: undefined as
          | ReadableStreamDefaultController<Uint8Array>
          | undefined,
        close() {
          try {
            stream.controller?.error(new TypeError('network interrupted'));
          } catch {
            /* closed test stream */
          }
        },
        send(value: Record<string, unknown>) {
          const sequence = nextSequence();
          let payload: Record<string, unknown>;
          if (value.type === 'snapshot') {
            const suppliedSnapshot = value.snapshot as
              | Record<string, unknown>
              | undefined;
            const snapshot =
              suppliedSnapshot && Array.isArray(suppliedSnapshot.runtimes)
                ? suppliedSnapshot
                : (initial.snapshot as unknown as Record<string, unknown>);
            if (kind === 'shell')
              latestSnapshot = snapshot as typeof initial.snapshot;
            const applicationCursor =
              typeof snapshot.cursor === 'number' ? snapshot.cursor : 1;
            const sessionRuntime = (
              (snapshot.runtimes as
                | Array<{
                    session?: { id?: string };
                    extensionSurfaces?: Array<{
                      rendererId?: string;
                      viewModel?: { statuses?: Array<Record<string, unknown>> };
                    }>;
                  }>
                | undefined) ?? []
            ).find((runtime) => runtime.session?.id === sessionId);
            const delegateStatuses =
              sessionRuntime?.extensionSurfaces?.find(
                (surface) => surface.rendererId === 'delegate.status',
              )?.viewModel?.statuses ?? [];
            const activeDelegates = delegateStatuses.map((status, index) => ({
              runId: String(status.id ?? `delegate-${index + 1}`),
              ...(typeof status.sessionId === 'string'
                ? { sessionId: status.sessionId }
                : {}),
              lineageId: String(status.id ?? `delegate-${index + 1}`),
              name: String(status.name ?? `Delegate ${index + 1}`),
              kind: status.kind === 'foreground' ? 'foreground' : 'background',
              state:
                status.state === 'success' ||
                status.state === 'error' ||
                status.state === 'aborted' ||
                status.state === 'timed-out'
                  ? status.state
                  : status.state === 'running'
                    ? 'running'
                    : 'queued',
              createdAt:
                typeof status.createdAt === 'number' ? status.createdAt : 1,
              ...(typeof status.startedAt === 'number'
                ? { startedAt: status.startedAt }
                : {}),
              ...(typeof status.jobId === 'string'
                ? { jobId: status.jobId }
                : {}),
              ...(typeof status.route === 'string'
                ? { route: status.route }
                : {}),
              ...(status.context === 'branch' || status.context === 'fresh'
                ? { context: status.context }
                : {}),
              allowWrites: status.allowWrites === true,
              ...(status.details && typeof status.details === 'object'
                ? { details: status.details }
                : {}),
              ...(status.pauseState === 'paused' ||
              status.pauseState === 'pausing'
                ? { pauseState: status.pauseState }
                : {}),
              ...(typeof status.pausedAt === 'number'
                ? { pausedAt: status.pausedAt }
                : {}),
              transcript: Array.isArray(status.transcript)
                ? status.transcript
                : [],
            }));
            payload =
              kind === 'shell'
                ? {
                    type: 'snapshot',
                    sequence,
                    snapshot: { snapshot, cursor: applicationCursor },
                  }
                : {
                    type: 'snapshot',
                    sequence,
                    snapshot: {
                      serverId: initial.snapshot.serverId,
                      cursor: applicationCursor,
                      metadata: {
                        id: sessionId,
                        file: '/tmp/project/session.jsonl',
                        cwd: '/tmp/project',
                        title:
                          sessionId === 's1'
                            ? 'Existing session request'
                            : 'Inspect the project setup',
                        updatedAt: applicationCursor,
                        ...(sessionId === 's1'
                          ? {
                              activeRuntimeId: 'r1',
                              entryCount: initial.entries.length,
                            }
                          : { workspaceId: 'w1', entryCount: 1 }),
                      },
                      entries:
                        sessionId === 's1'
                          ? ((value.entries as unknown[] | undefined) ??
                            initial.entries)
                          : [],
                      entriesComplete: true,
                      active: {
                        messages: [],
                        tools: [],
                        delegates: activeDelegates,
                        truncated: false,
                      },
                      completeThroughCursor: true,
                    },
                  };
          } else {
            const event = value.event;
            payload = {
              type: 'session-event',
              sequence,
              sessionId,
              event,
              ...(value.runtimeId === undefined
                ? {}
                : { runtimeId: value.runtimeId }),
            };
          }
          try {
            stream.controller?.enqueue(
              new TextEncoder().encode(
                trackedFrame(`${kind}-${sequence}`, payload),
              ),
            );
          } catch {
            /* stale stream */
          }
        },
      } as Stream;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.controller = controller;
          controller.enqueue(
            new TextEncoder().encode(
              'event: connected\ndata: {"reconnectAfterInactivityMs":60000}\n\n',
            ),
          );
        },
      });
      setTimeout(() => {
        (kind === 'shell' ? shellStreams : sessionStreams).push(stream);
        if (kind === 'shell')
          stream.send({ type: 'snapshot', snapshot: latestSnapshot });
        else {
          stream.send({ type: 'snapshot', snapshot: latestSnapshot });
          const sequence = sessionSequences.get(sessionId) ?? 0;
          try {
            stream.controller?.enqueue(
              new TextEncoder().encode(
                trackedFrame(`${kind}-${sequence}`, {
                  type: 'caught-up',
                  sequence,
                }),
              ),
            );
          } catch {
            /* stale stream */
          }
        }
      }, 0);
      return {
        stream,
        response: new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      };
    };
    window.fetch = async (input, init) => {
      const target =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (target.includes('/trpc/shellSubscribe'))
        return createStream('shell').response;
      if (target.includes('/trpc/sessionSubscribe')) {
        if (initialSessionRequest) {
          initialSessionRequest = false;
          return originalFetch(input, init);
        }
        let sessionId = 's1';
        try {
          const rawBody =
            typeof init?.body === 'string'
              ? init.body
              : input instanceof Request
                ? await input.clone().text()
                : '';
          const urlInput = new URL(target).searchParams.get('input');
          const body = rawBody
            ? JSON.parse(rawBody)
            : urlInput
              ? JSON.parse(urlInput)
              : {};
          sessionId =
            typeof body.sessionId === 'string'
              ? body.sessionId
              : typeof body.input?.sessionId === 'string'
                ? body.input.sessionId
                : sessionId;
        } catch {
          /* default session */
        }
        return createStream('session', sessionId).response;
      }
      return originalFetch(input, init);
    };
    Object.assign(window, {
      phase6Stream: {
        current: () => sessionStreams.at(-1) ?? shellStreams.at(-1),
        shell: () => shellStreams.at(-1),
        session: () => sessionStreams.at(-1),
        sendShellSnapshot: (value: Record<string, unknown>) => {
          for (const stream of shellStreams) stream.send(value);
        },
        sendSessionSnapshot: (value: Record<string, unknown>) => {
          for (const stream of sessionStreams) stream.send(value);
        },
        count: () => shellStreams.length + sessionStreams.length,
      },
    });
  }, initialFixture);
  await page.route('**/api/usage', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{}' }),
  );
  await installDashboardBootstrap(page, initialFixture.snapshot);
  await page.route('**/trpc/sessionSubscribe*', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: trpcSseData(
        {
          type: 'snapshot',
          sequence: 1,
          snapshot: {
            serverId: initialFixture.snapshot.serverId,
            cursor: 1,
            metadata: {
              id: 's1',
              file: '/tmp/project/session.jsonl',
              cwd: '/tmp/project',
              title: 'Existing session request',
              updatedAt: 1,
              activeRuntimeId: 'r1',
              entryCount: initialFixture.entries.length,
            },
            entries: initialFixture.entries,
            entriesComplete: true,
            active: {
              messages: [],
              tools: [],
              delegates: [],
              truncated: false,
            },
            completeThroughCursor: true,
          },
        },
        'session-phase-six-initial',
      ),
    }),
  );
  await page.route('**/trpc/composerFileSuggestions', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        suggestions: [
          {
            value: 'src/file.js',
            label: 'file.js',
            directory: false,
          },
        ],
      }),
    }),
  );
  await page.route('**/api/workspaces/refresh', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        workspaces: [
          {
            id: 'w1',
            name: 'Refreshed project',
            path: '/tmp/project',
            canonicalPath: '/tmp/project',
            source: 'directory',
            active: true,
          },
        ],
      }),
    }),
  );
  await page.route('**/trpc/startRuntime', async (route) => {
    const input = dashboardTrpcInput(route.request());
    starts.push(input);
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        commandId: input.commandId,
        status: 'completed',
        result: { runtimeId: 'r-launched' },
      }),
    });
  });
  await page.route('**/trpc/restartRuntime', async (route) => {
    const input = dashboardTrpcInput(route.request());
    restarts.push(input);
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        commandId: input.commandId,
        status: 'completed',
        result: { runtimeId: 'r-restarted' },
      }),
    });
  });
  await page.route('**/trpc/stopRuntime', async (route) => {
    const input = dashboardTrpcInput(route.request());
    stops.push(input);
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        commandId: input.commandId,
        status: 'completed',
        result: { runtimeId: input.runtimeId, stopped: true },
      }),
    });
  });
  await page.route('**/trpc/runtimeCommand', async (route) => {
    const input = dashboardTrpcInput(route.request());
    const command = input.command as Record<string, unknown> | undefined;
    if (command) commands.push(command);
    else commands.push({ type: 'invalid-command' });
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        runtimeId: input.runtimeId,
        commandId: command?.id,
        status: 'completed',
        result: { accepted: true },
      }),
    });
  });
  await page.route('**/api/runtimes/r1/command', async (route) => {
    const body = route.request().postData() ?? '';
    commands.push({ type: 'multipart', body });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, result: { accepted: true } }),
    });
  });
  await page.route('**/api/push/vapid-public-key', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ publicKey: null }),
    }),
  );
  return {
    commands,
    starts,
    stops,
    restarts,
    emit: async (value: Record<string, unknown>) => {
      await page.waitForFunction(
        () => {
          const phase6Stream = (
            window as unknown as {
              phase6Stream?: { current(): unknown };
            }
          ).phase6Stream;
          return phase6Stream?.current() !== undefined;
        },
        undefined,
        { timeout: 5_000 },
      );
      const record =
        value.type === 'snapshot' && value.snapshot === undefined
          ? { ...value, snapshot: phase6Snapshot() }
          : value;
      return page.evaluate((record) => {
        const phase6Stream = (
          window as unknown as {
            phase6Stream: {
              shell():
                | { send(value: Record<string, unknown>): void }
                | undefined;
              session():
                | { send(value: Record<string, unknown>): void }
                | undefined;
              sendShellSnapshot(value: Record<string, unknown>): void;
              sendSessionSnapshot(value: Record<string, unknown>): void;
            };
          }
        ).phase6Stream;
        if (record.type === 'session-snapshot') {
          phase6Stream.sendSessionSnapshot({ ...record, type: 'snapshot' });
        } else if (record.type === 'snapshot') {
          phase6Stream.sendShellSnapshot(record);
          phase6Stream.sendSessionSnapshot(record);
        } else phase6Stream.session()?.send(record);
      }, record);
    },
    close: async () =>
      page.evaluate(() =>
        (
          window as unknown as {
            phase6Stream: { current(): { close(): void } | undefined };
          }
        ).phase6Stream
          .current()
          ?.close(),
      ),
    streamCount: () =>
      page.evaluate(() =>
        (
          window as unknown as { phase6Stream: { count(): number } }
        ).phase6Stream.count(),
      ),
  };
}

test('keeps virtual row measurements after appending a user message @desktop', async ({
  page,
}) => {
  const entries = [
    ...Array.from({ length: 84 }, (_, index) => ({
      type: 'message',
      message: { role: 'user', content: `Earlier history ${index + 1}` },
    })),
    ...Array.from({ length: 12 }, (_, index) => [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `Activity ${index + 1}` },
            {
              type: 'toolCall',
              id: `append-read-${index}`,
              name: 'read',
              arguments: { path: `/tmp/project/file-${index}.ts` },
            },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: `append-read-${index}`,
          content: `result ${index + 1}`,
          isError: false,
        },
      },
    ]).flat(),
  ];
  const mocks = await installPhase6Mocks(page, {
    entries,
    snapshot: phase6Snapshot({ liveState: 'idle' }),
  });

  await page.goto('/sessions/s1');
  await scrollTranscript(page, Number.MAX_SAFE_INTEGER);
  await expect(page.getByText('Activity 12', { exact: true })).toBeVisible();
  await expect
    .poll(() => virtualTranscriptOverlap(page))
    .toBeLessThanOrEqual(1);
  await expect.poll(mocks.streamCount).toBeGreaterThan(1);

  const composer = page.getByLabel('Message Pi');
  await composer.fill('New user message');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await transcriptScroll(page).evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollTop - 1);
    element.dispatchEvent(new Event('scroll'));
  });
  await mocks.emit({
    type: 'session-snapshot',
    entries: [
      ...entries,
      {
        type: 'message',
        message: { role: 'user', content: 'New user message' },
      },
    ],
  });

  await expect(
    page.getByText('New user message', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => virtualTranscriptOverlap(page))
    .toBeLessThanOrEqual(1);
});

test('shows structured delegate content while the delegate is running @desktop', async ({
  page,
}) => {
  const mocks = await installPhase6Mocks(page, {
    snapshot: phase6Snapshot({
      extensionSurfaces: [
        {
          id: 'delegate-status',
          rendererId: 'delegate.status',
          viewModel: {
            version: 1,
            statuses: [
              {
                id: 'live-review',
                runId: 'live-review-run',
                sessionId: 'child-session',
                lineageId: 'live-review-lineage',
                name: 'Live review',
                kind: 'background',
                state: 'running',
                createdAt: 1,
                startedAt: 2,
                allowWrites: false,
                isolation: 'shared',
                details: {
                  task: 'Review the running implementation.',
                  setup: { cwd: '/tmp/project', isolation: 'shared' },
                  runConfig: {
                    scope: ['extensions/delegate'],
                    after: ['gate@1'],
                    parentContextNote: 'Keep the live review focused.',
                  },
                  renderedPrompt: 'Full rendered child prompt',
                  truncated: false,
                },
                transcript: [],
              },
            ],
          },
        },
      ],
    }),
  });
  await page.setViewportSize({ width: 960, height: 760 });
  await page.goto('/sessions/s1');

  const launcher = page.getByRole('button', {
    name: /Delegates.*1 running/u,
  });
  await expect(launcher).toBeVisible();
  await launcher.click();
  await page.getByRole('button', { name: /Live review/u }).click();

  const inspector = page.locator('.delegate-transcript-inspector-body');
  await expect(
    inspector.getByText('Review the running implementation.'),
  ).toBeVisible();
  await expect(inspector.getByText('Delegate setup')).toBeVisible();
  await expect(inspector.getByText('extensions/delegate')).toBeVisible();
  await expect(
    inspector.getByText('Keep the live review focused.'),
  ).toBeVisible();
  const renderedPrompt = inspector.getByText('Full rendered child prompt');
  await expect(renderedPrompt).toBeHidden();
  await inspector.getByText('Rendered prompt').click();
  await expect(renderedPrompt).toBeVisible();
  await expect(
    inspector.locator('.delegate-canonical-session-transcript'),
  ).toBeVisible();

  await mocks.emit({
    event: {
      type: 'message.finished',
      sessionId: 'child-session',
      message: {
        messageId: 'child-live-update',
        role: 'assistant',
        content: [{ type: 'text', text: 'Live update from child bridge' }],
        phase: 'finished',
      },
    },
  });
  await expect(
    inspector.getByText('Live update from child bridge'),
  ).toBeVisible();
  await mocks.close();
});

test('layers delegate details over the preserved list @desktop', async ({
  page,
}) => {
  const mocks = await installPhase6Mocks(page, {
    snapshot: phase6Snapshot({
      extensionSurfaces: [
        {
          id: 'delegate-status',
          rendererId: 'delegate.status',
          viewModel: {
            version: 1,
            statuses: [
              {
                id: 'live-review',
                runId: 'live-review-run',
                sessionId: 'child-session',
                lineageId: 'live-review-lineage',
                name: 'Live review',
                kind: 'background',
                state: 'running',
                createdAt: 1,
                startedAt: 2,
                allowWrites: false,
                isolation: 'shared',
                details: {
                  task: 'Review the running implementation.',
                  setup: { cwd: '/tmp/project', isolation: 'shared' },
                  runConfig: {
                    scope: ['extensions/delegate'],
                    after: ['gate@1'],
                    parentContextNote: 'Keep the live review focused.',
                  },
                  renderedPrompt: 'Full rendered child prompt',
                  truncated: false,
                },
                transcript: [],
              },
            ],
          },
        },
      ],
    }),
  });
  await page.setViewportSize({ width: 960, height: 760 });
  await page.goto('/sessions/s1');

  const launcher = page.getByRole('button', {
    name: /Delegates.*1 running/u,
  });
  await launcher.click();
  const delegateRow = page.getByRole('button', { name: /Live review/u });
  await delegateRow.focus();
  await delegateRow.click();

  const dialog = page.getByRole('dialog', {
    name: 'Delegate · Live review',
  });
  const surfacePages = page.locator('.surface-stack-page');
  const delegateListPage = surfacePages.first();
  await expect(dialog).toHaveAttribute('data-surface-depth', '2');
  await expect(surfacePages).toHaveCount(2);
  await expect(delegateListPage).toHaveAttribute('aria-hidden', 'true');
  await expect(delegateListPage).toHaveAttribute('inert', '');
  await expect(
    page.locator('.delegate-transcript-inspector-body'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Back to delegates' }).click();
  await expect(page.getByRole('dialog', { name: 'Delegates' })).toBeVisible();
  await expect(delegateRow).toBeVisible();
  await expect(delegateRow).toBeFocused();

  await delegateRow.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Delegates' })).toBeVisible();
  await expect(delegateRow).toBeFocused();

  await delegateRow.click();
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'Delegates' })).toBeVisible();
  await expect(page).toHaveURL(/\/sessions\/s1$/u);
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(launcher).toBeFocused();

  await launcher.click();
  await delegateRow.click();
  await swipe(page.locator('.surface-drawer'), { dx: 104, dy: 8 });
  await expect(page.getByRole('dialog', { name: 'Delegates' })).toBeVisible();

  await delegateRow.click();
  await page
    .locator('.surface-drawer-layer')
    .click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole('dialog', { name: 'Delegates' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(launcher).toBeFocused();
  await mocks.close();
});

test('runtime restart stays on the current thread with pending status', async ({
  page,
}) => {
  await installPhase6Mocks(page);
  let releaseRestart!: () => void;
  const restartPending = new Promise<void>((resolve) => {
    releaseRestart = resolve;
  });
  await page.route('**/trpc/restartRuntime', async (route) => {
    const input = dashboardTrpcInput(route.request());
    await restartPending;
    await route.fulfill({
      contentType: 'application/json',
      body: trpcData({
        commandId: input.commandId,
        status: 'completed',
        result: { runtimeId: 'r-restarted' },
      }),
    });
  });
  await page.goto('/sessions/s1');
  const originalUrl = page.url();
  await page.getByRole('button', { name: 'Open agent list' }).click();
  const nav = page.getByRole('complementary', { name: 'Agents and threads' });
  await expect(nav).toBeVisible();
  const row = nav.locator('.agent-thread-row.status-working').first();
  const thread = row.getByRole('button');
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Restart' }).click();

  await expect(thread).toHaveAccessibleName(/restarting/u);
  await expect(row).toContainText('restarting');
  await expect(page).toHaveURL(originalUrl);

  releaseRestart();
  await expect(page.getByRole('menu', { name: /Actions for/u })).toHaveCount(0);
  await expect(page).toHaveURL(originalUrl);
});

test('assistant preambles render as ordinary Markdown messages @desktop', async ({
  page,
}) => {
  await installPhase6Mocks(page, {
    entries: markdownActivityEntries(),
  });
  await page.setViewportSize({ width: 960, height: 760 });
  await page.goto('/sessions/s1');

  const message = page.locator('.message-bubble.message-assistant').first();
  await expect(message.locator('.markdown strong')).toHaveText(
    'Review the workspace',
  );
  await expect(message.locator('.markdown a')).toHaveAttribute(
    'href',
    'https://example.com/guide',
  );
  await expect(
    message.getByRole('button', { name: 'Copy assistant message' }),
  ).toBeVisible();
  await expect(page.locator('.transcript-tool-stream')).toHaveCount(0);
  await expect(page.locator('.tool-stream-meta')).toHaveCount(0);
  await expect(page.locator('.tool-stream-toggle')).toHaveCount(0);
  await expect(page.locator('.tool-detail')).toHaveCount(1);
});

test('assistant Markdown keeps block-first semantics in a normal message @desktop', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) =>
          sessionStorage.setItem('copied-code-block', text),
      },
    });
  });
  await installPhase6Mocks(page, {
    entries: markdownActivityEntries({ blockFirst: true }),
  });
  await page.setViewportSize({ width: 960, height: 760 });
  await page.goto('/sessions/s1');

  const message = page.locator('.message-bubble.message-assistant').first();
  await expect(message.locator('.markdown > h2')).toHaveText(
    'Block-first preamble',
  );
  await expect(message.locator('.markdown > ul')).toBeVisible();
  await expect(message.locator('.markdown > pre')).toBeVisible();
  await message.getByRole('button', { name: 'Copy assistant message' }).click();
  await expect(
    message.getByRole('button', { name: 'Copied assistant message' }),
  ).toBeVisible();
});

test('composer text wraps around top-right actions @desktop', async ({
  page,
}) => {
  await installPhase6Mocks(page, {
    entries: repeatedActivityEntries(),
  });
  await page.setViewportSize({ width: 960, height: 760 });
  await page.goto('/sessions/s1');

  const editor = page.getByRole('textbox', { name: 'Message Pi' });
  await expect(editor).toBeVisible();
  await editor.fill('Composer text '.repeat(80));

  const geometry = await page
    .locator('.composer-rich-surface')
    .evaluate((surface) => {
      const mount = surface.querySelector<HTMLElement>(
        '.composer-editor-mount',
      );
      const actions = surface.querySelector<HTMLElement>('.composer-actions');
      const editable = surface.querySelector<HTMLElement>('[role="textbox"]');
      const textNode = editable
        ? document.createTreeWalker(editable, NodeFilter.SHOW_TEXT).nextNode()
        : null;
      if (!mount || !actions || !textNode)
        throw new Error('Composer layout is incomplete');

      const surfaceRect = surface.getBoundingClientRect();
      const mountRect = mount.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      const lines = new Map<number, { left: number; right: number }>();
      const range = document.createRange();
      const text = textNode.textContent ?? '';
      for (let index = 0; index < text.length; index += 1) {
        range.setStart(textNode, index);
        range.setEnd(textNode, index + 1);
        const rect = range.getBoundingClientRect();
        const line = Math.round(rect.top);
        const bounds = lines.get(line);
        lines.set(line, {
          left: Math.min(bounds?.left ?? rect.left, rect.left),
          right: Math.max(bounds?.right ?? rect.right, rect.right),
        });
      }
      const lineBounds = [...lines.entries()]
        .sort(([topA], [topB]) => topA - topB)
        .map(([, bounds]) => bounds);
      return {
        surfaceWidth: surfaceRect.width,
        mountWidth: mountRect.width,
        actionsLeft: actionsRect.left,
        firstLineRight: lineBounds[0]?.right ?? 0,
        laterLineRight: Math.max(
          ...lineBounds.slice(2).map(({ right }) => right),
        ),
        lineCount: lineBounds.length,
      };
    });

  expect(Math.abs(geometry.surfaceWidth - geometry.mountWidth)).toBeLessThan(2);
  expect(geometry.lineCount).toBeGreaterThan(3);
  expect(geometry.firstLineRight).toBeLessThan(geometry.actionsLeft);
  expect(geometry.laterLineRight).toBeGreaterThan(geometry.actionsLeft);
});

test('virtual transcript keeps flat tool streams inside simple contracts', async ({
  page,
}) => {
  const mocks = await installPhase6Mocks(page, {
    entries: repeatedActivityEntries(),
  });
  await page.goto('/sessions/s1');
  const composer = page.locator('.composer');
  const composerInput = page.locator('.composer [role="textbox"]');
  await expect(composerInput).toBeVisible();
  await composerInput.focus();
  const composerFocus = await composer.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
      rect,
    };
  });
  expect(composerFocus.outlineStyle).toBe('none');
  expect(composerFocus.boxShadow).toContain('inset');
  expect(composerFocus.rect.width).toBeGreaterThan(0);
  expect(composerFocus.rect.height).toBeGreaterThan(0);

  await expect(page.locator('.transcript-virtualized')).toHaveCount(1);
  await expect(page.locator('.transcript-tool-stream')).toHaveCount(0);
  await expect(page.locator('.tool-stream-meta')).toHaveCount(0);
  await expect(page.locator('.tool-stream-toggle')).toHaveCount(0);
  const rowStyles = await page
    .locator('.transcript-virtual-row')
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { maxHeight: style.maxHeight, overflowY: style.overflowY };
    });
  expect(rowStyles).toEqual({ maxHeight: 'none', overflowY: 'visible' });
  await mocks.close();
});

async function assertLargeEditPreview(page: Page, historyCount: number) {
  const mocks = await installPhase6Mocks(page, {
    entries: phase6EditEntries(historyCount),
  });
  await page.goto('/sessions/s1');
  const tool = page
    .locator('.tool-detail')
    .filter({ hasText: 'Editing' })
    .first();
  await expect(tool).toBeVisible();
  await expect(page.locator('.tool-stream-meta')).toHaveCount(0);
  await expect(tool).not.toHaveCSS('overflow-y', 'auto');

  await scrollTranscript(page, Number.MAX_SAFE_INTEGER);
  expect(await transcriptGap(page)).toBeLessThan(3);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await mocks.close();
}

for (const historyCount of [6, 84]) {
  test(`large edit preview has no tail gap (${historyCount} items)`, async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await assertLargeEditPreview(page, historyCount);
  });
}

test('started session keeps location fixed and agent controls editable', async ({
  page,
}) => {
  const mocks = await installPhase6Mocks(page);
  const base = phase6Snapshot();
  const snapshot = {
    ...base,
    projects: [
      {
        id: 'project-1',
        title: 'Project',
        rootPath: '/tmp/project',
        status: 'active',
        maxParallelRuns: 4,
        activeRunCount: 1,
        updatedAt: 1,
      },
    ],
    checkouts: [
      {
        id: 'checkout-1',
        projectId: 'project-1',
        kind: 'main',
        path: '/tmp/project',
        branch: 'main',
        status: 'ready',
        updatedAt: 1,
      },
    ],
    runtimes: base.runtimes.map((runtime) => ({
      ...runtime,
      projectId: 'project-1',
      checkoutId: 'checkout-1',
    })),
    sessions: base.sessions.map((session) => ({
      ...session,
      projectId: 'project-1',
      checkoutId: 'checkout-1',
    })),
  } as import('@pi-dashboard/protocol').BrowserSnapshot;

  await page.goto('/sessions/s1');
  await mocks.emit({ type: 'snapshot', snapshot });
  const composer = page.locator('form.composer');
  await expect(composer.getByText('Mode:', { exact: true })).toHaveCount(0);
  await expect(composer.locator('.draft-picker-trigger-locked')).toContainText(
    'Current checkout · main',
  );
  const agent = composer.getByRole('button', { name: 'Agent and thinking' });
  await expect(agent).toContainText('Vision· medium');
  await agent.click();
  const picker = page.getByRole('dialog', { name: 'Agent and thinking' });
  await picker.getByRole('button', { name: /Text only/ }).click();
  await picker.getByRole('button', { name: 'high' }).click();
  await expect
    .poll(() => mocks.commands.filter((command) => command.type === 'setModel'))
    .toHaveLength(1);
  await expect
    .poll(
      () =>
        mocks.commands.filter((command) => command.type === 'setThinking')
          .length,
    )
    .toBe(1);
  await page.getByRole('button', { name: 'Close Agent and thinking' }).click();
  await expect(picker).toHaveCount(0);
  await mocks.close();
});

test('outline preview stays above the composer @desktop', async ({ page }) => {
  const mocks = await installPhase6Mocks(page);
  await page.goto('/sessions/s1');
  await mocks.emit({ type: 'snapshot', snapshot: phase6Snapshot() });

  const marker = page.locator(
    '.transcript-minimap-marker[data-preview="Earlier history 1"]',
  );
  await marker.hover();
  const preview = marker.locator('.transcript-minimap-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('data-meta', /User message · .+/u);
  await expect(preview).toHaveAttribute('data-label', 'Earlier history 1');
  const geometry = await marker.evaluate((element) => {
    const previewElement = element.querySelector<HTMLElement>(
      '.transcript-minimap-preview',
    );
    return {
      markerWidth: element.getBoundingClientRect().width,
      previewDoesNotCapturePointer:
        previewElement !== null &&
        getComputedStyle(previewElement).pointerEvents === 'none',
      minimapStackLevel: Number(
        getComputedStyle(element.closest('.transcript-minimap') as Element)
          .zIndex,
      ),
      composerStackLevel: Number(
        getComputedStyle(
          document.querySelector('.session-control-layer') as Element,
        ).zIndex,
      ),
      wraps:
        previewElement !== null &&
        getComputedStyle(previewElement).whiteSpace === 'normal',
    };
  });
  expect(geometry).toMatchObject({
    markerWidth: 64,
    previewDoesNotCapturePointer: true,
    minimapStackLevel: 31,
    composerStackLevel: 30,
    wraps: true,
  });
  expect(geometry.minimapStackLevel).toBeGreaterThan(
    geometry.composerStackLevel,
  );
  await mocks.close();
});

test('phase six mocked session flow covers semantic controls and reconnect safety', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await page.context().grantPermissions(['notifications']);
  const mocks = await installPhase6Mocks(page);
  await page.goto('/sessions/s1');
  await expect(page.locator('.session-heading h1')).toHaveText(
    'Existing session request',
  );
  await mocks.emit({ type: 'snapshot', snapshot: phase6Snapshot() });
  const runtimeAgent = page.getByRole('button', {
    name: 'Agent and thinking',
  });
  await expect(runtimeAgent).toContainText('Vision· medium');
  await runtimeAgent.click();
  const runtimeAgentPicker = page.getByRole('dialog', {
    name: 'Agent and thinking',
  });
  await runtimeAgentPicker.getByRole('button', { name: /Text only/ }).click();
  await expect
    .poll(() => mocks.commands.filter((command) => command.type === 'setModel'))
    .toEqual([
      expect.objectContaining({
        type: 'setModel',
        provider: 'test',
        model: 'text',
      }),
    ]);
  await runtimeAgentPicker.getByRole('button', { name: 'high' }).click();
  await expect
    .poll(
      () =>
        mocks.commands.filter((command) => command.type === 'setThinking')
          .length,
    )
    .toBe(1);
  await page.getByRole('button', { name: 'Close Agent and thinking' }).click();
  await expect(page.locator('.session-heading')).toContainText('Unassigned');
  await expect(page.locator('.session-heading')).not.toContainText(
    'test/vision',
  );
  await page.keyboard.press('Control+K');
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const dockMarker = page.locator(
    '.transcript-minimap-marker[data-preview="Earlier history 1"]',
  );
  await expect(dockMarker).toHaveCount(1);
  await expect(dockMarker).toHaveAttribute('aria-label', 'Earlier history 1');
  await expect(dockMarker).not.toHaveAttribute('title', 'Earlier history 1');
  await scrollTranscript(page, Number.MAX_SAFE_INTEGER);
  const assistant = page
    .locator('.message-assistant')
    .filter({ hasText: 'Inspecting history' })
    .first();
  await expect(assistant).toBeVisible();
  const activity = page
    .locator('.tool-detail')
    .filter({ hasText: 'Reading' })
    .first();
  await expect(activity.getByText('Reading', { exact: true })).toBeVisible();
  await expect(
    activity.getByText('src/App.tsx', { exact: true }),
  ).toBeVisible();
  await expect(
    activity.getByText('/tmp/project/src/App.tsx', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('.transcript-thinking-blob')
      .getByText('Considering the workspace'),
  ).toBeVisible();
  const toolSummary = activity.locator(':scope > summary.tool-step');
  await expect(toolSummary.getByText('Reading', { exact: true })).toBeVisible();
  await toolSummary.click();
  await expect(activity).toHaveAttribute('open', '');
  await toolSummary.click();
  await expect(activity).not.toHaveAttribute('open', '');
  expect(
    mocks.commands.filter(
      (command) => command.actionId === 'activity-groups.set',
    ),
  ).toHaveLength(0);

  await scrollTranscript(page, 0);
  await page.waitForTimeout(150);
  await expect(
    page.getByRole('paragraph').filter({ hasText: /^Earlier history 1$/u }),
  ).toBeVisible();
  await expect.poll(() => transcriptGap(page)).toBeGreaterThan(120);
  await scrollTranscript(page, Number.MAX_SAFE_INTEGER);
  await mocks.emit({
    type: 'snapshot',
  });
  const deliveryMode = page.getByRole('button', {
    name: 'Steer current work instead of following up later',
  });
  await expect(deliveryMode).toHaveCount(1);
  await expect(deliveryMode).toHaveText('Steer');
  await expect(deliveryMode).toHaveAttribute('aria-pressed', 'true');
  const workingComposerInput = page.getByLabel('Message Pi');
  const abortTurn = page.getByRole('button', { name: 'Abort turn' });
  await expect(abortTurn).toBeVisible();
  await abortTurn.click();
  await expect
    .poll(() => mocks.commands.some((command) => command.type === 'abort'))
    .toBe(true);
  await workingComposerInput.fill('/compact');
  await expect(
    page.getByRole('listbox', { name: 'Autocomplete suggestions' }),
  ).toHaveCount(0);
  await workingComposerInput.fill('');
  await deliveryMode.click();
  await expect(deliveryMode).toHaveText('Later');
  await expect(deliveryMode).toHaveAttribute('aria-pressed', 'false');
  const commandCountBeforeFollowUp = mocks.commands.length;
  await workingComposerInput.fill('Follow up while delegates run');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect
    .poll(() => mocks.commands.slice(commandCountBeforeFollowUp).at(-1))
    .toMatchObject({
      type: 'followUp',
      text: 'Follow up while delegates run',
    });
  expect(
    mocks.commands
      .slice(commandCountBeforeFollowUp)
      .some(
        (command) =>
          command.type === 'queue.add' &&
          command.text === 'Follow up while delegates run',
      ),
  ).toBe(false);
  await mocks.emit({
    type: 'snapshot',
    snapshot: phase6Snapshot({ liveState: 'idle' }),
  });
  const composerInput = page.getByLabel('Message Pi');
  await expect(composerInput).toBeEnabled();
  expect(
    await composerInput.evaluate(
      (element) => getComputedStyle(element).fontSize,
    ),
  ).toBe('14px');
  await composerInput.fill('$bro');
  const skillOption = page.getByRole('option', { name: /\$browser/ });
  await expect(skillOption).toBeVisible();
  expect(await skillOption.locator('mark').allTextContents()).toEqual([
    'b',
    'r',
    'o',
  ]);
  await composerInput.press('Tab');
  await expect(composerInput).toContainText('$browser');
  await composerInput.press('Escape');
  await expect(
    page.getByRole('listbox', { name: 'Autocomplete suggestions' }),
  ).toHaveCount(0);

  await composerInput.fill('foo @src/fi bar');
  for (let index = 0; index < 4; index += 1)
    await composerInput.press('ArrowLeft');
  const fileOption = page.getByRole('option', { name: /@src\/file\.js/ });
  await expect(fileOption).toBeVisible();
  await expect(fileOption.locator('.composer-autocomplete-detail')).toHaveCount(
    0,
  );
  await expect(fileOption).not.toContainText('FILE');
  await composerInput.press('Tab');
  await expect(composerInput).toContainText('foo @src/file.js bar');
  expect(
    await composerInput.evaluate(() => window.getSelection()?.anchorOffset),
  ).toBe('foo @src/file.js'.length);
  await composerInput.fill('');
  const initialComposerHeight = await composerInput.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await composerInput.fill(
    Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'),
  );
  const grownComposerHeight = await composerInput.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(grownComposerHeight).toBeGreaterThan(initialComposerHeight);
  expect(grownComposerHeight).toBeLessThanOrEqual(180);
  await composerInput.fill(
    Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n'),
  );
  const cappedComposer = await composerInput.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
  }));
  expect(cappedComposer.height).toBeLessThanOrEqual(180);
  expect(cappedComposer.scrollHeight).toBeGreaterThan(cappedComposer.height);
  await composerInput.fill('');
  await composerInput.pressSequentially('# ');
  await composerInput.pressSequentially('Live markdown heading');
  await expect(
    page
      .locator('.composer-rich-editor')
      .getByRole('heading', { name: 'Live markdown heading' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Preview', exact: true }),
  ).toHaveCount(0);
  await scrollTranscript(page, 0);
  await expect.poll(() => transcriptGap(page)).toBeGreaterThan(120);
  await composerInput.fill('stream this');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => transcriptGap(page)).toBeLessThanOrEqual(1);
  await expect
    .poll(() => mocks.commands.some((command) => command.type === 'prompt'))
    .toBe(true);
  await page.getByLabel('Choose images').setInputFiles({
    name: 'phase6.png',
    mimeType: 'image/png',
    buffer: Buffer.from([1, 2, 3]),
  });
  await expect(page.getByAltText('phase6.png')).toBeVisible();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect
    .poll(() => mocks.commands.some((command) => command.type === 'multipart'))
    .toBe(true);
  await page.keyboard.press('Control+K');
  const paletteSearch = page.getByRole('combobox', {
    name: 'Search commands, threads, and projects',
  });
  await paletteSearch.fill('Unsafe');
  await expect(page.getByText('No results for "Unsafe".')).toBeVisible();
  await paletteSearch.fill('Compact');
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      mocks.commands.some((command) => command.actionId === 'session.compact'),
    )
    .toBe(true);

  await mocks.close();
  await expect.poll(mocks.streamCount).toBeGreaterThan(1);
  await page.reload();
  await expect(page.locator('.session-heading h1')).toHaveText(
    'Existing session request',
  );
});
