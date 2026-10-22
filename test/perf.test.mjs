// A large schema pair compares well under a second: a generated schema the size of
// GitHub's (about 1 MB of SDL, some 1,500 types), and its introspection form.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { core } from './helpers.mjs';

const graphql = createRequire(import.meta.url)('graphql');

function bigSchema(n, mutate = false) {
  const out = ['type Query {', ...Array.from({ length: n }, (_, i) => `  t${i}(id: ID!, first: Int = 10, after: String): T${i}`), '}', ''];
  for (let i = 0; i < n; i++) {
    out.push(`"""\nType number ${i}, with a description long enough to take some room in the file.\n"""`);
    out.push(`type T${i} implements Node {`, '  id: ID!');
    for (let f = 0; f < 10; f++) out.push(`  """Field ${f} of type ${i}."""\n  field${f}(arg: String, limit: Int = ${f}): ${f % 3 === 0 ? `[T${(i + f) % n}!]!` : f % 3 === 1 ? 'String' : `E${i % 50}`}${mutate && i % 97 === 0 && f === 2 ? '!' : ''}`);
    out.push('}', '');
  }
  for (let e = 0; e < 50; e++) out.push(`enum E${e} { A B C D${mutate && e % 7 === 0 ? ' E' : ''} }`);
  out.push('interface Node { id: ID! }');
  for (let i = 0; i < 100; i++) out.push(`input I${i} { a: Int b: String = "x" c: [ID!]${mutate && i % 10 === 0 ? ' d: Int!' : ''} }`);
  return out.join('\n');
}

const N = 1500;
const a = bigSchema(N);
const b = bigSchema(N, true);

test(`a ${(a.length / 1e6).toFixed(1)} MB schema pair (${N} types) compares in well under a second`, () => {
  // Once to warm the JIT, as the extension's worker is warm after its first comparison.
  core.compare({ text: a, path: '/x/a.graphql' }, { text: b, path: '/x/b.graphql' });
  // The best of three: the test files run side by side, and a busy machine is not the engine.
  let r;
  let ms = Infinity;
  for (let i = 0; i < 3; i++) {
    core.clearCache();
    const t = process.hrtime.bigint();
    r = core.compare({ text: a, path: '/x/a.graphql' }, { text: b, path: '/x/b.graphql' });
    ms = Math.min(ms, Number(process.hrtime.bigint() - t) / 1e6);
  }
  assert.deepEqual(r.errors, {});
  const n = core.count(r.changes);
  assert.equal(n.error, 10, 'required input fields added');
  assert.equal(n.warning, 8, 'enum values added, returned by fields');
  assert.equal(n.info, 16, 'fields became non-null');
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
  console.log(`    ${(a.length / 1e6).toFixed(1)} MB SDL pair: ${ms.toFixed(0)} ms`);
});

test("a pair of introspection results the size of GitHub's (about 5 MB each), with positions", () => {
  const json = (sdl) => JSON.stringify(graphql.introspectionFromSchema(graphql.buildSchema(sdl), { descriptions: true, inputValueDeprecation: true }), null, 2);
  const ja = json(bigSchema(400));
  const jb = json(bigSchema(400, true));
  core.clearCache();
  const t = process.hrtime.bigint();
  const r = core.compare({ text: ja, path: '/x/a.json' }, { text: jb, path: '/x/b.json' });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.deepEqual(r.errors, {});
  assert.ok(r.changes.length > 20, `${r.changes.length} changes`);
  assert.ok(r.changes.every((c) => (c.old ?? c.new).line > 0), 'positions found in the JSON');
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
  console.log(`    ${(ja.length / 1e6).toFixed(1)} MB introspection pair: ${ms.toFixed(0)} ms`);
});

test('the cache: comparing again after an edit to one side parses only that side', () => {
  core.clearCache();
  core.compare({ text: a, path: '/x/a.graphql' }, { text: b, path: '/x/b.graphql' });
  const t = process.hrtime.bigint();
  core.compare({ text: a, path: '/x/a.graphql' }, { text: b + '\n', path: '/x/b.graphql' });
  const both = Number(process.hrtime.bigint() - t) / 1e6;
  const t2 = process.hrtime.bigint();
  core.compare({ text: a, path: '/x/a.graphql' }, { text: b + '\n', path: '/x/b.graphql' });
  const none = Number(process.hrtime.bigint() - t2) / 1e6;
  assert.ok(none < both, `${none.toFixed(0)} ms with both cached, ${both.toFixed(0)} ms with one`);
});
