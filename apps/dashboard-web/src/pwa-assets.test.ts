import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const publicUrl = new URL('../public/', import.meta.url);

function readPublic(path: string): Buffer {
  return readFileSync(new URL(path, publicUrl));
}

function pngDimensions(path: string): { width: number; height: number } {
  const png = readPublic(path);
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('PWA assets', () => {
  it('declares a standalone app with regular and maskable icons', () => {
    const manifest = JSON.parse(
      readPublic('manifest.webmanifest').toString('utf8'),
    ) as {
      id: string;
      start_url: string;
      scope: string;
      display: string;
      icons: { src: string; sizes: string; purpose: string }[];
    };

    expect(manifest).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
        expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
        expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
      ]),
    );

    for (const icon of manifest.icons) {
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(pngDimensions(icon.src.slice(1))).toEqual({ width, height });
    }
  });

  it('provides Apple standalone metadata and a touch icon', () => {
    const html = readFileSync(
      new URL('../index.html', import.meta.url),
      'utf8',
    );

    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(pngDimensions('icons/apple-touch-icon.png')).toEqual({
      width: 180,
      height: 180,
    });
  });

  it('keeps the service worker limited to updates and notifications', () => {
    const serviceWorker = readPublic('sw.js').toString('utf8');

    expect(serviceWorker).toContain("'__PI_DASHBOARD_BUILD_ID__'");
    expect(serviceWorker).toContain('self.skipWaiting()');
    expect(serviceWorker).toContain("key.startsWith('pi-dashboard-')");
    expect(serviceWorker).toContain('self.clients.claim()');
    expect(serviceWorker).toContain('client.navigate(client.url)');
    expect(serviceWorker).not.toContain('addAll');
    expect(serviceWorker).not.toContain('respondWith');
    expect(serviceWorker).not.toContain("caches.match('/')");
  });
});
