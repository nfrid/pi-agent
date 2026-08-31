import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const MAX_ICON_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;

const ICON_CANDIDATES = [
  'favicon.svg',
  'favicon.ico',
  'favicon.png',
  'public/favicon.svg',
  'public/favicon.ico',
  'public/favicon.png',
  'app/favicon.ico',
  'app/favicon.png',
  'app/icon.svg',
  'app/icon.png',
  'app/icon.ico',
  'src/favicon.ico',
  'src/favicon.svg',
  'src/app/favicon.ico',
  'src/app/icon.svg',
  'src/app/icon.png',
  'assets/icon.svg',
  'assets/icon.png',
  'assets/logo.svg',
  'assets/logo.png',
  '.idea/icon.svg',
] as const;

const ICON_SOURCE_FILES = [
  'index.html',
  'public/index.html',
  'app/routes/__root.tsx',
  'src/routes/__root.tsx',
  'app/root.tsx',
  'src/root.tsx',
  'src/index.html',
] as const;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

export interface ProjectIcon {
  data: Buffer;
  mediaType: string;
}

function overridePath(stateDir: string, projectId: string): string {
  const name = createHash('sha256').update(projectId).digest('hex');
  return path.join(stateDir, 'project-icons', `${name}.png`);
}

export async function readProjectIconOverride(
  stateDir: string,
  projectId: string,
): Promise<ProjectIcon | undefined> {
  const iconPath = overridePath(stateDir, projectId);
  try {
    const metadata = await stat(iconPath);
    if (!metadata.isFile() || metadata.size > MAX_ICON_BYTES) return undefined;
    return { data: await readFile(iconPath), mediaType: 'image/png' };
  } catch {
    return undefined;
  }
}

export async function writeProjectIconOverride(
  stateDir: string,
  projectId: string,
  input: Buffer,
): Promise<void> {
  if (input.length === 0 || input.length > MAX_ICON_BYTES)
    throw new Error('Project icons must be 5 MB or smaller.');
  let data: Buffer;
  try {
    data = await sharp(input, {
      failOn: 'error',
      limitInputPixels: 16_000_000,
    })
      .rotate()
      .resize({
        width: 256,
        height: 256,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  } catch {
    throw new Error('Choose a valid image file.');
  }
  const iconPath = overridePath(stateDir, projectId);
  const temporaryPath = `${iconPath}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(iconPath), { recursive: true });
  try {
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, iconPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function deleteProjectIconOverride(
  stateDir: string,
  projectId: string,
): Promise<void> {
  await rm(overridePath(stateDir, projectId), { force: true });
}

function iconHref(source: string): string | undefined {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  for (const run of source.split('}')) {
    if (!ICON_REL_RE.test(run)) continue;
    const hrefMatch = run.match(ICON_HREF_RE);
    if (hrefMatch?.[1]) return hrefMatch[1];
  }
  return undefined;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function containedFile(
  root: string,
  relativePath: string,
): Promise<string | undefined> {
  if (!relativePath || path.isAbsolute(relativePath)) return undefined;
  const candidate = path.resolve(root, relativePath);
  if (!isWithinRoot(root, candidate)) return undefined;
  try {
    const resolved = await realpath(candidate);
    if (!isWithinRoot(root, resolved)) return undefined;
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size > MAX_ICON_BYTES) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

async function containedIcon(
  root: string,
  relativePath: string,
): Promise<string | undefined> {
  if (!MEDIA_TYPES[path.extname(relativePath).toLowerCase()]) return undefined;
  return containedFile(root, relativePath);
}

async function sourceIcon(root: string): Promise<string | undefined> {
  for (const relativePath of ICON_SOURCE_FILES) {
    const sourcePath = await containedFile(root, relativePath);
    if (!sourcePath) continue;
    try {
      const metadata = await stat(sourcePath);
      if (metadata.size > MAX_SOURCE_BYTES) continue;
      const href = iconHref(await readFile(sourcePath, 'utf8'));
      if (!href) continue;
      const clean = href.replace(/^\//, '');
      const resolved =
        (await containedIcon(root, path.join('public', clean))) ??
        (await containedIcon(root, clean));
      if (resolved) return resolved;
    } catch {}
  }
  return undefined;
}

export async function readProjectIcon(
  rootPath: string,
): Promise<ProjectIcon | undefined> {
  let root: string;
  try {
    root = await realpath(rootPath);
  } catch {
    return undefined;
  }
  let iconPath: string | undefined;
  for (const candidate of ICON_CANDIDATES) {
    iconPath = await containedIcon(root, candidate);
    if (iconPath) break;
  }
  iconPath ??= await sourceIcon(root);
  if (!iconPath) return undefined;
  const mediaType = MEDIA_TYPES[path.extname(iconPath).toLowerCase()];
  if (!mediaType) return undefined;
  try {
    return { data: await readFile(iconPath), mediaType };
  } catch {
    return undefined;
  }
}
