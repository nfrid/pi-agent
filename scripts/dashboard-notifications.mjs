import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(
  root,
  'apps/dashboard-notifications/dist/Pi Dashboard Notifications.app',
);
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}`);
}
if (process.platform !== 'darwin')
  throw new Error('Native notifications require macOS.');
const mode = process.argv[2] ?? 'build';
if (!['build', 'install', 'test', 'click'].includes(mode))
  throw new Error('Use build, install, test, or click.');
if (mode === 'click') {
  const api = new URL(process.argv[3]);
  const url = process.argv[4];
  if (api.protocol !== 'http:' || api.hostname !== '127.0.0.1' || !url)
    throw new Error(
      'Supply a loopback API origin and exact local session URL.',
    );
  const token = (await readFile('/dev/stdin', 'utf8')).trim();
  if (!token) throw new Error('Supply the dashboard token on standard input.');
  const response = await fetch(new URL('/trpc/nativeControl', api), {
    method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:4174',
      'content-type': 'application/json',
      'x-dashboard-token': token,
      'x-dashboard-protocol-version': '3',
    },
    body: JSON.stringify({ action: 'click', url }),
  });
  if (!response.ok) throw new Error(`Diagnostic rejected: ${response.status}`);
  const result = await response.json();
  console.log(JSON.stringify(result));
  if (result.result?.data?.permission !== 'diagnostic')
    throw new Error('The helper did not accept the click.');
} else {
  await mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
  await mkdir(path.join(app, 'Contents/Resources/Pi.iconset'), {
    recursive: true,
  });
  run('swiftc', [
    '-swift-version',
    '5',
    '-O',
    path.join(root, 'apps/dashboard-notifications/main.swift'),
    '-o',
    path.join(app, 'Contents/MacOS/PiNotifications'),
  ]);
  const iconset = path.join(app, 'Contents/Resources/Pi.iconset');
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      run('sips', [
        '-z',
        String(size * scale),
        String(size * scale),
        path.join(root, 'apps/dashboard-web/public/icons/icon-512.png'),
        '--out',
        path.join(
          iconset,
          `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`,
        ),
      ]);
    }
  }
  run('iconutil', [
    '-c',
    'icns',
    iconset,
    '-o',
    path.join(app, 'Contents/Resources/Pi.icns'),
  ]);
  await rm(iconset, { recursive: true });
  await writeFile(
    path.join(app, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.pi.dashboard.notifications</string>
<key>CFBundleName</key><string>Pi Dashboard Notifications</string>
<key>CFBundleExecutable</key><string>PiNotifications</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>Pi.icns</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>15.0</string>
</dict></plist>
`,
  );
  run('codesign', [
    '--force',
    '--sign',
    process.env.PI_NOTIFICATIONS_SIGN_IDENTITY ?? '-',
    '--identifier',
    'com.pi.dashboard.notifications',
    app,
  ]);
  run('codesign', ['--verify', '--strict', app]);
  if (mode === 'test')
    run(path.join(app, 'Contents/MacOS/PiNotifications'), ['--self-test']);
  if (mode === 'install') {
    const destination = path.join(
      homedir(),
      'Applications/Pi Dashboard Notifications.app',
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(app, destination, { recursive: true });
    run(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', destination],
    );
  }
}
