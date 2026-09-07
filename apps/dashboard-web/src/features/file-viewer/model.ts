import type { FileLocation } from './reference';

export type ViewerMode = 'source' | 'preview';

/** Undefined means this mode has not been visited; zero is a real position. */
export type ViewerScrollPositions = {
  source?: number;
  preview?: number;
};

export type ViewerEntry = {
  location: FileLocation;
  mode: ViewerMode;
  scrollTop: ViewerScrollPositions;
};

export function fileLocationKey(location: FileLocation): string {
  return JSON.stringify([
    location.path,
    location.cwd ?? '',
    location.startLine ?? null,
    location.endLine ?? null,
    location.heading ?? null,
  ]);
}
