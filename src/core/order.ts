export interface Candidate {
  /** The file name, such as `schema-v2.graphql`. */
  name: string;
}

/** Numbers in a version: `v1.4.0` → [1, 4, 0], `2024-05-01` → [2024, 5, 1]. */
export function versionParts(s: string): number[] | undefined {
  const m = s.match(/\d+(?:[._-]\d+)*/);
  return m ? m[0].split(/[._-]/).map(Number) : undefined;
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const OLD_WORDS = /(^|[^a-z])(old|older|before|prev|previous|base|baseline|orig|original|legacy|from)([^a-z]|$)/i;
const NEW_WORDS = /(^|[^a-z])(new|newer|after|next|current|head|latest|updated|modified|to)([^a-z]|$)/i;
/** A version in a file name: `-v2`, `_2.1`, `.2024-05-01`, `v3`. */
const NAME_VERSION = /(?:^|[-_. ])v?(\d+(?:[._-]\d+)*)(?=[-_. ]|$)/i;

const stem = (name: string) => name.replace(/\.(graphqls?|gql|json)$/i, '');

/**
 * Which of two schema files is the old one, and why; undefined when nothing says. A
 * GraphQL schema carries no version, so only the names can tell: words in them (old/new,
 * before/after…), then versions in them (`schema.graphql` and `schema-v2.graphql`: the
 * one with a version is newer).
 */
export function guessOrder(a: Candidate, b: Candidate): { old: 0 | 1; why: string } | undefined {
  const sa = stem(a.name);
  const sb = stem(b.name);
  const oa = OLD_WORDS.test(sa) && !OLD_WORDS.test(sb);
  const ob = OLD_WORDS.test(sb) && !OLD_WORDS.test(sa);
  const na = NEW_WORDS.test(sa) && !NEW_WORDS.test(sb);
  const nb = NEW_WORDS.test(sb) && !NEW_WORDS.test(sa);
  if ((oa || nb) && !(ob || na)) return { old: 0, why: 'names' };
  if ((ob || na) && !(oa || nb)) return { old: 1, why: 'names' };
  const ma = sa.match(NAME_VERSION);
  const mb = sb.match(NAME_VERSION);
  if (ma && mb) {
    const d = compareVersions(versionParts(ma[1])!, versionParts(mb[1])!);
    if (d) return { old: d < 0 ? 0 : 1, why: 'names' };
  } else if (ma || mb) {
    const plain = (s: string, m: RegExpMatchArray | null) => (m ? s.slice(0, m.index) + s.slice(m.index! + m[0].length) : s);
    if (plain(sa, ma).toLowerCase() === plain(sb, mb).toLowerCase()) return { old: ma ? 1 : 0, why: 'names' };
  }
  return undefined;
}
