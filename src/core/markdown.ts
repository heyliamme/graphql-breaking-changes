import type { Change } from './diff';
import { codeSpan, mdText } from './md';
import { count } from './policy';
import { KIND_NAME, type Level } from './types';

const HEADINGS: Record<Level, string> = { error: 'Breaking changes', warning: 'Dangerous changes', info: 'Other changes' };

/** How a change's place is named in lists: `User`, `@key`, or "Schema". */
export const groupLabel = (c: Pick<Change, 'kind' | 'type'>) => c.type ?? 'Schema';

/** `type User`, `enum Status`, `directive @key`, `schema`. */
export const groupTitle = (c: Pick<Change, 'kind' | 'type'>) => (c.type ? `${KIND_NAME[c.kind]} ${c.type}` : 'schema');

const ORDER: Record<string, number> = { SCHEMA: 0, DIRECTIVE: 2 };
const rank = (c: Pick<Change, 'kind'>) => ORDER[c.kind] ?? 1;

/** Schema first, then types by name, then directives. */
export function compareGroups(a: Pick<Change, 'kind' | 'type'>, b: Pick<Change, 'kind' | 'type'>): number {
  return rank(a) - rank(b) || (a.type ?? '').localeCompare(b.type ?? '');
}

/**
 * Bullets for a list of changes, grouped by type: one line for a type with one change,
 * a nested list for a type with several.
 */
function bullets(of: Change[], suffix = (_: Change) => ''): string[] {
  const groups = new Map<string, Change[]>();
  for (const c of of) {
    const k = groupLabel(c);
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const keys = [...groups.keys()].sort((x, y) => compareGroups(groups.get(x)![0], groups.get(y)![0]));
  const lines: string[] = [];
  for (const k of keys) {
    const cs = groups.get(k)!;
    const title = codeSpan(groupTitle(cs[0]));
    if (cs.length === 1) lines.push(`- ${title}: ${cs[0].message}${suffix(cs[0])}`);
    else {
      lines.push(`- ${title}`);
      for (const c of cs) lines.push(`  - ${c.message}${suffix(c)}`);
    }
  }
  return lines;
}

/** A changelog for a pull request. Ignored changes are left out. */
export function toMarkdown(changes: Change[], title: string): string {
  const shown = changes.filter((c) => c.ignored === undefined);
  const n = count(changes);
  const lines = [`### ${oneLine(title)}`, ''];
  const parts = [`**${n.error} breaking**`, `${n.warning} dangerous`, `${n.info} other`];
  if (n.ignored) parts.push(`${n.ignored} ignored`);
  lines.push(parts.join(' · '), '');
  if (!shown.length) {
    lines.push('No changes for API clients.');
    return lines.join('\n') + '\n';
  }
  for (const level of ['error', 'warning', 'info'] as Level[]) {
    const of = shown.filter((c) => c.level === level);
    if (!of.length) continue;
    lines.push(`#### ${HEADINGS[level]}`, '', ...bullets(of), '');
  }
  return lines.join('\n');
}

export type ReleaseSection = 'breaking' | 'dangerous' | 'added' | 'changed';

/**
 * Where a change goes in release notes: breaking first, then dangerous, then what
 * clients can start using, then everything else.
 */
export function releaseSection(c: Pick<Change, 'id' | 'level'>): ReleaseSection {
  if (c.level === 'error') return 'breaking';
  if (c.level === 'warning') return 'dangerous';
  if (/-added$/.test(c.id)) return 'added';
  return 'changed';
}

export interface ReleaseNotesInfo {
  /** The old and the new version, as Markdown (names in code spans): tags, branches, "the working copy". */
  from: string;
  to: string;
  /** The schema file, for the heading: `schema.graphql`. */
  schema?: string;
}

const SECTION_TITLES: Record<ReleaseSection, string> = { breaking: 'Breaking changes', dangerous: 'Dangerous changes', added: 'Added', changed: 'Changed' };

/**
 * Release notes for API clients: what changed between two versions, grouped Breaking /
 * Dangerous / Added / Changed. Ignored changes are left out.
 */
export function toReleaseNotes(changes: Change[], info: ReleaseNotesInfo): string {
  const shown = changes.filter((c) => c.ignored === undefined);
  const lines = [`## Schema changes in ${oneLine(info.to)}`, ''];
  const compared = `Changes since ${oneLine(info.from)}${info.schema ? `, in ${codeSpan(info.schema)}` : ''}.`;
  const by: Record<ReleaseSection, Change[]> = { breaking: [], dangerous: [], added: [], changed: [] };
  for (const c of shown) by[releaseSection(c)].push(c);
  const n = (k: ReleaseSection, one: string, many: string) => (by[k].length ? `${by[k].length} ${by[k].length === 1 ? one : many}` : '');
  const summary = [n('breaking', 'breaking change', 'breaking changes'), n('dangerous', 'dangerous change', 'dangerous changes'), n('added', 'addition', 'additions'), n('changed', 'other change', 'other changes')].filter(Boolean);
  lines.push(compared + (summary.length ? ` ${cap(summary.join(', '))}.` : ''), '');
  if (!shown.length) {
    lines.push('No changes for API clients.');
    return lines.join('\n') + '\n';
  }
  for (const k of ['breaking', 'dangerous', 'added', 'changed'] as ReleaseSection[]) {
    if (!by[k].length) continue;
    lines.push(`### ${SECTION_TITLES[k]}`, '', ...bullets(by[k], (c) => (k === 'dangerous' ? ' _(may break some clients)_' : '')), '');
  }
  return lines.join('\n');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A heading the caller wrote (its names already in code spans): kept on one line. */
const oneLine = (s: string) => s.replace(/\r\n?|\n/g, ' ');

export { mdText };
