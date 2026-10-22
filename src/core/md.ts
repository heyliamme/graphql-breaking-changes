/**
 * Markdown that spec content can't break out of. Enum values, names and paths come from
 * the spec, which may be someone else's: a backtick in one would otherwise end the code
 * span and turn the rest into live Markdown (links, images, mentions).
 */

/** A code span around any text: on one line, with a fence longer than any backtick run inside. */
export function codeSpan(v: unknown): string {
  const s = String(v).replace(/\r\n?|\n/g, ' ');
  let longest = 0;
  for (const run of s.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  if (!longest) return '`' + s + '`';
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${s} ${fence}`;
}

/**
 * Plain text for Markdown, on one line: what could start a code span, a link, an image or
 * HTML is escaped, and an `@` can't mention anyone. Emphasis and the like are left alone.
 */
export function mdText(v: unknown): string {
  return String(v)
    .replace(/\r\n?|\n/g, ' ')
    .replace(/[\\`[\]<>]/g, '\\$&')
    .replace(/@/g, '@\u200b');
}
