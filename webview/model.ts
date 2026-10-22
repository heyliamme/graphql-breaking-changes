import type { Change } from '../src/core/diff';
import { KIND_NAME, type Kind, type Level } from '../src/core/types';

const LEVEL_RANK: Record<Level, number> = { error: 0, warning: 1, info: 2 };
const KIND_RANK: Partial<Record<Kind, number>> = { SCHEMA: 0, DIRECTIVE: 2 };

export interface Group {
  key: string;
  kind: Kind;
  /** The type's name, `@name` for a directive; none for the schema. */
  type?: string;
  /** Indexes into the report's change list. */
  items: number[];
}

export const groupKey = (c: Pick<Change, 'kind' | 'type'>) => (c.type ? `${KIND_NAME[c.kind]} ${c.type}` : 'schema');

/** Changes by type: the schema first, then types by name, then directives. */
export function groupChanges(changes: Change[]): Group[] {
  const groups = new Map<string, Group>();
  changes.forEach((c, i) => {
    const k = groupKey(c);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { key: k, kind: c.kind, type: c.type, items: [] }));
    g.items.push(i);
  });
  const out = [...groups.values()];
  out.sort((a, b) => (KIND_RANK[a.kind] ?? 1) - (KIND_RANK[b.kind] ?? 1) || (a.type ?? '').localeCompare(b.type ?? ''));
  // Within a type, breaking first, then by field; otherwise the order they were found in.
  for (const g of out) g.items.sort((x, y) => LEVEL_RANK[changes[x].level] - LEVEL_RANK[changes[y].level] || (changes[x].field ?? '').localeCompare(changes[y].field ?? '') || x - y);
  return out;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Escapes a message and turns `code spans` into <code>, pairing fences of the same length
 * the way Markdown does (``a `b` c`` is one span).
 */
export function messageHtml(s: string): string {
  return esc(s).replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _f: string, body: string) => `<code>${/^ [\s\S]* $/.test(body) && body.trim() ? body.slice(1, -1) : body}</code>`);
}

/** Every word of the query appears in the change's type, field, kind, id or message. */
export function matchesQuery(c: Change, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${KIND_NAME[c.kind]} ${c.type ?? 'schema'} ${c.field ?? ''} ${c.id} ${c.message}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}
