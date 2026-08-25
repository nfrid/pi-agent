import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const plistPath = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  'com.pi.dashboard.plist',
);

if (process.platform !== 'darwin') {
  process.stderr.write(
    'Dashboard deploy requires macOS and the com.pi.dashboard LaunchAgent.\n',
  );
  process.exit(1);
}
if (!existsSync(plistPath)) {
  process.stderr.write(
    `Dashboard LaunchAgent not found at ${plistPath}. Install the customized deploy/com.pi.dashboard.plist before deploying.\n`,
  );
  process.exit(1);
}

let plist;
try {
  plist = JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', '--', plistPath], {
      encoding: 'utf8',
    }),
  );
} catch (error) {
  process.stderr.write(
    `Unable to read ${plistPath} with plutil: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

const args = plist.ProgramArguments;
const ownsDashboard =
  Array.isArray(args) &&
  args.at(-2) === 'scripts/dashboard-dev.mjs' &&
  args.at(-1) === 'serve';
if (!ownsDashboard || plist.AbandonProcessGroup !== false) {
  process.stderr.write(
    `${plistPath} is stale or unsafe: install the versioned dashboard template so it runs scripts/dashboard-dev.mjs serve with AbandonProcessGroup=false.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Dashboard LaunchAgent ownership contract verified: ${plistPath}\n`,
);
