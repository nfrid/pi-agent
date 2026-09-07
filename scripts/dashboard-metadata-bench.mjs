// Build the server first; run: node scripts/dashboard-metadata-bench.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DashboardApplication } from '../apps/dashboard-server/dist/application/dashboard-application.js';
import { MetadataStore } from '../apps/dashboard-server/dist/metadata.js';
import { SessionIndex } from '../apps/dashboard-server/dist/session-index.js';

const iterations = 50;
const samples = 7;
console.log(
  JSON.stringify({ node: process.version, samples, iterations, warmups: 10 }),
);
for (const size of [1_000, 5_000]) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'dashboard-metadata-bench-'),
  );
  let metadata;
  let sessions;
  let app;
  try {
    const sessionDir = path.join(root, 'sessions');
    await mkdir(sessionDir);
    // Fixture setup is outside the timed region and limits open-file pressure.
    for (let index = 0; index < size; index += 1) {
      await writeFile(
        path.join(sessionDir, `session-${index}.jsonl`),
        `${JSON.stringify({
          type: 'session',
          id: `session-${index}`,
          cwd: root,
          timestamp: index,
        })}\n`,
      );
    }
    metadata = new MetadataStore(path.join(root, 'state', 'dashboard.sqlite'));
    sessions = new SessionIndex(sessionDir, metadata);
    const current = {
      runtimeId: 'metadata-bench-runtime',
      ownership: 'external',
      pid: 1,
      cwd: root,
      liveState: 'idle',
      session: { id: `session-${size - 1}`, entries: [], title: 'initial' },
    };
    const registry = {
      snapshots: () => [{ ...current, session: { ...current.session } }],
      close: () => undefined,
    };
    app = new DashboardApplication({
      registry,
      manager: { onRegistryChange: () => undefined },
      sessions,
      metadata,
      usage: { get: async () => null },
      push: { notify: async () => undefined },
      stateDir: path.join(root, 'state'),
    });
    await app.start();
    app.initializeSessionMetadataBaseline();
    for (let index = 0; index < 10; index += 1) {
      current.session.title = `warmup-${index}`;
      app.sessionMetadataDeltaForSession(current.session.id);
    }
    const elapsed = [];
    let changes = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      const start = performance.now();
      for (let index = 0; index < iterations; index += 1) {
        current.session.title = `measured-${sample}-${index}`;
        if (app.sessionMetadataDeltaForSession(current.session.id))
          changes += 1;
      }
      elapsed.push((performance.now() - start) / iterations);
    }
    assert.equal(changes, samples * iterations);
    elapsed.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        size,
        medianPerCallMs: elapsed[Math.floor(samples / 2)],
        p95BatchMeanMs: elapsed[Math.ceil(samples * 0.95) - 1],
        changes,
      }),
    );
  } finally {
    await app?.usage.stop();
    await app?.uploads.close();
    sessions?.close();
    app?.notifications.close();
    metadata?.close();
    await rm(root, { recursive: true, force: true });
  }
}
