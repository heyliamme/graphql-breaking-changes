/**
 * A small glob matcher for the `schemaFiles` setting, applied to POSIX paths relative to
 * the folder of the schema file: `**` any number of segments (including none), `*` any run
 * inside one segment, `?` one character, `{a,b}` alternatives (globs themselves). A
 * leading `./` is dropped.
 *
 * No regular expression: a pattern from a workspace's settings must not be able to make
 * matching backtrack for ever. Segments are matched with the usual one-backtrack-point
 * wildcard walk, at worst the product of the two lengths.
 */
export function globMatcher(pattern: string): (relativePath: string) => boolean {
  const p = pattern.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  if (!p) return () => false;
  const alternatives = expand(p).map(segments);
  return (path) => {
    const parts = path.replace(/^\.\//, '').split('/');
    return alternatives.some((segs) => matchPath(segs, parts));
  };
}

/** Brace alternatives expanded, at most this many patterns. */
const MAX_ALTERNATIVES = 64;

function expand(p: string): string[] {
  const open = p.indexOf('{');
  const close = open < 0 ? -1 : p.indexOf('}', open);
  if (close < 0) return [p];
  const head = p.slice(0, open);
  const rest = expand(p.slice(close + 1));
  const out: string[] = [];
  for (const alt of p.slice(open + 1, close).split(','))
    for (const r of rest) {
      if (out.length >= MAX_ALTERNATIVES) return out;
      out.push(head + alt + r);
    }
  return out;
}

/**
 * A pattern's segments. A `**` inside a segment (`**.graphql`, `types**`) stands for any
 * folders and then a `*`, as it did in the regular expression this replaced.
 */
function segments(p: string): string[] {
  const out: string[] = [];
  for (const s of p.split('/')) {
    if (s === '**' || !s.includes('**')) {
      // Runs of `**` segments are one.
      if (s !== '**' || out[out.length - 1] !== '**') out.push(s);
      continue;
    }
    const collapsed = s.replace(/\*{2,}/g, '**');
    if (collapsed.startsWith('**')) {
      if (out[out.length - 1] !== '**') out.push('**');
      out.push(collapsed.slice(1).replace(/\*\*/g, '*'));
    } else if (collapsed.endsWith('**')) {
      out.push(collapsed.slice(0, -1).replace(/\*\*/g, '*'), '**');
    } else out.push(collapsed.replace(/\*\*/g, '*'));
  }
  return out;
}

/** Segments against path parts, `**` matching any number of parts. */
function matchPath(pat: string[], parts: string[]): boolean {
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < parts.length) {
    if (i < pat.length && pat[i] === '**') {
      star = i++;
      mark = j;
    } else if (i < pat.length && matchSegment(pat[i], parts[j])) {
      i++;
      j++;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (i < pat.length && pat[i] === '**') i++;
  return i === pat.length;
}

/** One segment: `*` any run, `?` one character. */
function matchSegment(pat: string, s: string): boolean {
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < s.length) {
    if (i < pat.length && (pat[i] === '?' || (pat[i] !== '*' && pat[i] === s[j]))) {
      i++;
      j++;
    } else if (i < pat.length && pat[i] === '*') {
      star = i++;
      mark = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (i < pat.length && pat[i] === '*') i++;
  return i === pat.length;
}

/** Whether a pattern stays inside the folder it is relative to. */
export function isSafeGlob(pattern: string): boolean {
  return !pattern.split('/').includes('..') && !/^\//.test(pattern.trim());
}
