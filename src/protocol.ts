import type { Change, Counts, LoadError, SideInfo as Loaded } from './core';

export type SideName = 'old' | 'new';

export interface SideInfo {
  label: string;
  /** Second line: "api/schema.graphql at main", "working copy". */
  detail?: string;
  /** The main file's path as the engine saw it, to tell the other files of a split schema apart. */
  path: string;
  /** SDL or introspection, and how many types: shown next to the name. */
  info?: Loaded;
  error?: LoadError;
}

export interface Report {
  /** Echoed by the view's messages about it, so that the host can drop those about an older report. */
  id: number;
  old: SideInfo;
  new: SideInfo;
  changes: Change[];
  counts: Counts;
  warnings: string[];
  ms: number;
  /** "warnings as errors" is on. */
  strict: boolean;
}

export type ToWebview =
  | { type: 'loading' }
  | { type: 'report'; report: Report }
  /** What the serializer needs to reopen the report; the view stores it with its own state. */
  | { type: 'persist'; state: unknown }
  | { type: 'view'; view: ViewState };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'open'; report: number; side: SideName; file: string; line: number; col: number }
  | { type: 'copyMarkdown'; report: number }
  | { type: 'releaseNotes'; report: number }
  | { type: 'ignore'; report: number; index: number }
  | { type: 'swap' }
  | { type: 'refresh' };

/** What the view remembers across reloads: filters and folded groups. */
export interface ViewState {
  levels?: Record<string, boolean>;
  query?: string;
  collapsed?: string[];
}
