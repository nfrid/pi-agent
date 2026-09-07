import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { DashboardApplication } from '../apps/dashboard-server/src/application/dashboard-application.js';
import { MetadataStore } from '../apps/dashboard-server/src/metadata.js';
import type { RuntimeRegistry } from '../apps/dashboard-server/src/runtime-registry.js';
import { SessionIndex } from '../apps/dashboard-server/src/session-index.js';

const SIZES = [1_000, 5_000];
const ITERATIONS = 50;

type MutableRuntime = RuntimeSnapshot & {
  session: RuntimeSnapshot['session'] & { title?: string };
};

async function benchmark(size: number): Promise<void> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'dashboard-metadata-bench-'),
  );
  const sessionDir = path.join(root, 'sessions');
  await mkdir(sessionDir, { recursive: true });
  await Promise.all(
    Array.from({ length: size }, (_, index) =>
      writeFile(
        path.join(sessionDir, `session-${index}.jsonl`),
        `${JSON.stringify({
          type: 'session',
          id: `session-${index}`,
          cwd: '/tmp/dashboard-metadata-bench',
          timestamp: index,
        })}\n`,
      ),
    ),
  );

  const metadata = new MetadataStore(
    path.join(root, 'state', 'dashboard.sqlite'),
  );
  const sessions = new SessionIndex(sessionDir, metadata);
  let current: MutableRuntime;
  const registry = {
    snapshots: () => [{ ...current, session: { ...current.session } }],
    close: () => undefined,
  } as unknown as RuntimeRegistry;
  const app = new DashboardApplication({
    registry,
    manager: { onRegistryChange: () => undefined } as never,
    sessions,
    metadata,
    usage: { get: async () => null },
    push: { notify: async () => undefined },
    stateDir: path.join(root, 'state'),
  });
  current = {
    runtimeId: 'metadata-bench-runtime',
    ownership: 'external',
    pid: 1,
    cwd: '/tmp/dashboard-metadata-bench',
    liveState: 'idle',
    session: { id: `session-${size - 1}`, entries: [], title: 'initial' },
  };

  try {
    await app.start();
    app.initializeSessionMetadataBaseline();
    for (let index = 0; index < 10; index += 1) {
      current.session.title = `warmup-${index}`;
      app.sessionMetadataDeltaForSession(`session-${size - 1}`);
    }
    const start = performance.now();
    let changes = 0;
    for (let index = 0; index < ITERATIONS; index += 1) {
      current.session.title = `measured-${index}`;
      if (app.sessionMetadataDeltaForSession(`session-${size - 1}`))
        changes += 1;
    }
    const elapsed = performance.now() - start;
    console.log(
      JSON.stringify({
        size,
        iterations: ITERATIONS,
        elapsedMs: Number(elapsed.toFixed(2)),
        perCallMs: Number((elapsed / ITERATIONS).toFixed(4)),
        changes,
      }),
    );
  } finally {
    await app.usage.stop();
    await app.uploads.close();
    sessions.close();
    app.notifications.close();
    metadata.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const size of SIZES) await benchmark(size);
