// The README's tables of change ids, from the rule catalog. The tests check that the
// README contains exactly this.
//   npm run build && node scripts/rules-table.mjs
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const core = createRequire(import.meta.url)('../dist/core.js');
const level = (l) => (typeof l === 'string' ? { error: 'breaking', warning: 'dangerous', info: 'info' }[l] : l.varies);

export function tables() {
  const out = [];
  const groups = new Map();
  for (const r of core.allRules()) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  for (const [g, rules] of groups) {
    out.push(`#### ${g}`, '', '| Id | Level | Change |', '| --- | --- | --- |');
    for (const r of rules) out.push(`| \`${r.id}\` | ${level(r.level)} | ${r.summary} |`);
    out.push('');
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(tables());
