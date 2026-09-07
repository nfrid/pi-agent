/** A host-file destination, independent of its renderer or the current route. */
export type FileLocation = {
  path: string;
  cwd?: string;
  startLine?: number;
  endLine?: number;
  heading?: string;
};

export type FileLinkBase = { cwd?: string; path?: string };

/** Parse local Markdown destinations only; never reinterpret URL schemes as files. */
export function parseFileReference(
  href: string,
  base: FileLinkBase = {},
): FileLocation | undefined {
  if (!href || href.startsWith('//')) return undefined;
  const hash = href.indexOf('#');
  let path: string;
  let fragment: string | undefined;
  try {
    path = decodeURIComponent(hash < 0 ? href : href.slice(0, hash));
    fragment = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
  } catch {
    return undefined;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in file destinations.
  if (/[\u0000-\u001f\u007f]/u.test(path) || path.startsWith('//'))
    return undefined;

  const lineSuffix = /:(\d+)(?:-(\d+))?$/u.exec(path);
  if (lineSuffix) path = path.slice(0, lineSuffix.index);
  if (/^[a-z][a-z\d+.-]*:/iu.test(path)) return undefined;
  if (path.startsWith('~') && !path.startsWith('~/')) return undefined;
  if (!path) {
    if (!base.path || fragment === undefined) return undefined;
    path = base.path;
  }
  const lineFragment = /^L(\d+)(?:-L?(\d+))?$/u.exec(fragment ?? '');
  const lines = lineFragment ?? lineSuffix;
  const startLine = lines ? Number(lines[1]) : undefined;
  const endLine = lines ? Number(lines[2] ?? lines[1]) : undefined;
  if (
    startLine !== undefined &&
    (!Number.isSafeInteger(startLine) ||
      startLine < 1 ||
      !Number.isSafeInteger(endLine) ||
      (endLine as number) < startLine)
  )
    return undefined;
  return {
    path,
    ...(base.cwd === undefined ? {} : { cwd: base.cwd }),
    ...(startLine === undefined ? {} : { startLine, endLine }),
    ...(!fragment || lineFragment ? {} : { heading: fragment }),
  };
}
