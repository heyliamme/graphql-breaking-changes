import type { Change } from './diff';
import { LEVEL_ORDER, type Level } from './types';

export interface IgnoreRule {
  id?: string;
  /** A type name, or `@name` for a directive. `*` matches any run of characters. */
  type?: string;
  /** A field, input field, enum value or union member name on that type. */
  field?: string;
  reason?: string;
}

export interface Policy {
  ignore: IgnoreRule[];
  warningsAsErrors: boolean;
}

/** Settings files can hold anything: keep the entries that make sense. */
export function readIgnore(raw: unknown): IgnoreRule[] {
  if (!Array.isArray(raw)) return [];
  const out: IgnoreRule[] = [];
  for (const x of raw) {
    if (typeof x === 'string' && x.trim()) out.push({ id: x.trim() });
    else if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      const rule: IgnoreRule = {};
      for (const k of ['id', 'type', 'field', 'reason'] as const) if (typeof o[k] === 'string' && (o[k] as string).trim()) rule[k] = (o[k] as string).trim();
      if (rule.id || rule.type || rule.field) out.push(rule);
    }
  }
  return out;
}

export interface NameMatcher {
  test(name: string): boolean;
}

const compiled = new Map<string, NameMatcher>();

/**
 * `*` matches any run of characters; `\\*` is a `*`. Matched without a regular expression:
 * names come from the schema, and a backtracking `.*` per star takes seconds on a long one.
 */
export function nameMatcher(pattern: string): NameMatcher {
  const hit = compiled.get(pattern);
  if (hit) return hit;
  // The literal runs between stars.
  const parts = [''];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\' && i + 1 < pattern.length) parts[parts.length - 1] += pattern[++i];
    else if (pattern[i] === '*') parts.push('');
    else parts[parts.length - 1] += pattern[i];
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  const test = (s: string): boolean => {
    if (parts.length === 1) return s === first;
    if (s.length < first.length + last.length || !s.startsWith(first) || !s.endsWith(last)) return false;
    // Each run in between at its first place after the one before: leftmost is never worse.
    const end = s.length - last.length;
    let at = first.length;
    for (let k = 1; k < parts.length - 1; k++) {
      const run = parts[k];
      if (!run) continue;
      const i = s.indexOf(run, at);
      if (i < 0 || i + run.length > end) return false;
      at = i + run.length;
    }
    return true;
  };
  const m = { test };
  if (compiled.size >= 1000) compiled.clear();
  compiled.set(pattern, m);
  return m;
}

/** A name as written in a schema, as a pattern that matches only that name. */
export const escapeName = (name: string) => name.replace(/[\\*]/g, '\\$&');

export function matches(rule: IgnoreRule, c: Change): boolean {
  if (rule.id && !nameMatcher(rule.id).test(c.id)) return false;
  if (rule.type && (!c.type || !nameMatcher(rule.type).test(c.type))) return false;
  if (rule.field && (!c.field || !nameMatcher(rule.field).test(c.field))) return false;
  return true;
}

/** Marks ignored changes and applies "warnings as errors". Returns new objects. */
export function applyPolicy(changes: Change[], policy: Policy): Change[] {
  return changes.map((c) => {
    const out: Change = { ...c };
    if (policy.warningsAsErrors && out.level === 'warning') out.level = 'error';
    const hit = policy.ignore.find((r) => matches(r, c));
    if (hit) out.ignored = hit.reason ?? '';
    else delete out.ignored;
    return out;
  });
}

export interface Counts {
  error: number;
  warning: number;
  info: number;
  ignored: number;
}

export function count(changes: Change[]): Counts {
  const c: Counts = { error: 0, warning: 0, info: 0, ignored: 0 };
  for (const x of changes) {
    if (x.ignored !== undefined) c.ignored++;
    else c[x.level]++;
  }
  return c;
}

export function atLeast(level: Level, min: Level) {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[min];
}
