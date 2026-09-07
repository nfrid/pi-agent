import { createContext } from 'react';
import type { FileLinkBase } from './reference';

/** Origin of relative Markdown links, including archived and delegate transcripts. */
export const FileLinkContext = createContext<FileLinkBase>({});
