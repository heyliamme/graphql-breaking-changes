// Reading schemas: detection by content, positions, split schemas and extensions,
// introspection results, malformed input, the glob matcher.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { core, diff, ids, only } from './helpers.mjs';

const graphql = createRequire(import.meta.url)('graphql');

const Q = 'type Query { x: Int }\n';

test('looksLikeSchema: SDL by its definitions, introspection by __schema, nothing else', () => {
  assert.equal(core.looksLikeSchema('type Query { x: Int }'), 'sdl');
  assert.equal(core.looksLikeSchema('# comment\n"""doc"""\ninput Foo {\n  a: Int\n}'), 'sdl');
  assert.equal(core.looksLikeSchema('extend type Query { y: Int }'), 'sdl');
  assert.equal(core.looksLikeSchema('schema {\n query: Q\n}'), 'sdl');
  assert.equal(core.looksLikeSchema('schema @link(url: "x")'), 'sdl');
  assert.equal(core.looksLikeSchema('directive @d on FIELD'), 'sdl');
  assert.equal(core.looksLikeSchema('union U = A | B'), 'sdl');
  assert.equal(core.looksLikeSchema('scalar Date'), 'sdl');
  assert.equal(core.looksLikeSchema('﻿type Query { x: Int }'), 'sdl', 'BOM');
  assert.equal(core.looksLikeSchema('query { user { id } }'), undefined, 'an operation document');
  assert.equal(core.looksLikeSchema('fragment F on User { id }'), undefined);
  assert.equal(core.looksLikeSchema('{"__schema": {"types": []}}'), 'introspection');
  assert.equal(core.looksLikeSchema('{\n  "data": {\n    "__schema": {'), 'introspection');
  assert.equal(core.looksLikeSchema('{"openapi": "3.0.0"}'), undefined);
  assert.equal(core.looksLikeSchema('name: not a schema'), undefined);
  // Strict (a file not called .graphql): a root type or a schema block, not a lone enum.
  assert.equal(core.looksLikeSchema('enum Color {\n  Red,\n}', true), undefined, 'TypeScript enum');
  assert.equal(core.looksLikeSchema('type Foo = { a: string }', true), undefined, 'TypeScript type');
  assert.equal(core.looksLikeSchema('type Foo = { a: string }'), undefined, 'TypeScript type, even lenient');
  assert.equal(core.looksLikeSchema('enum Color { RED }\ntype Query { c: Color }', true), 'sdl');
  assert.equal(core.looksLikeSchema('extend type Mutation { x: Int }', true), 'sdl');
});

test('positions: every change points at the name in the old and the new file', () => {
  const a = 'type Query {\n  x: Int\n  y(a: Int): Int\n}\n\nenum E {\n  A\n  B\n}\n';
  const b = 'type Query {\n  x: String\n  y(a: Int!): Int\n}\n\nenum E {\n  A\n}\n';
  const r = diff(a, b);
  const at = (id) => only(r, id)[0];
  assert.deepEqual(at('field-type-changed').old, { file: '/api/old/schema.graphql', pointer: '/types/Query/fields/x', line: 1, col: 2 });
  assert.deepEqual(at('field-type-changed').new, { file: '/api/new/schema.graphql', pointer: '/types/Query/fields/x', line: 1, col: 2 });
  assert.deepEqual(at('argument-became-required').new, { file: '/api/new/schema.graphql', pointer: '/types/Query/fields/y/args/a', line: 2, col: 4 });
  assert.deepEqual(at('enum-value-removed').old, { file: '/api/old/schema.graphql', pointer: '/types/E/values/B', line: 7, col: 2 });
  assert.equal(at('enum-value-removed').new, undefined);
  // Type-level changes point at the type's name.
  const t = diff(Q + '"""a"""\ntype A { a: Int }', Q + 'type A { a: Int }');
  assert.deepEqual(t.changes[0].new, { file: '/api/new/schema.graphql', pointer: '/types/A/description', line: 1, col: 5 });
});

test('split schemas: files merge, extensions apply, changes point into the file they are in', () => {
  const main = 'type Query { a: Int }\n';
  const oldFiles = { 'types/b.graphql': 'extend type Query { b: Int }\ntype B { x: Int }\n', 'types/c.graphql': 'type C { y: Int! }\n' };
  const newFiles = { 'types/b.graphql': 'extend type Query { b: String }\ntype B { x: Int }\n', 'types/c.graphql': 'type C { y: Int }\n' };
  const r = diff(main, main, { oldFiles, newFiles });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(ids(r).sort(), ['error:field-became-nullable', 'error:field-type-changed']);
  assert.equal(only(r, 'field-type-changed')[0].new.file, '/api/new/types/b.graphql');
  assert.equal(only(r, 'field-became-nullable')[0].old.file, '/api/old/types/c.graphql');
  assert.deepEqual(r.files.new, ['/api/new/schema.graphql', '/api/new/types/b.graphql', '/api/new/types/c.graphql']);
  assert.equal(r.info.new.types, 3);
  // A file deleted since: its types are removed.
  const gone = diff(main, main, { oldFiles, newFiles: { 'types/b.graphql': oldFiles['types/b.graphql'] } });
  assert.deepEqual(ids(gone), ['error:type-removed']);
});

test('split schemas: extensions in any order, extensions of the main file, interfaces and values added by extension', () => {
  const r = diff(
    'type Query { a: Int }\nenum E { A }\n',
    'type Query { a: Int }\nenum E { A }\n',
    { oldFiles: { 'x.graphql': 'extend enum E { B }\nextend type Query { b: Int }\n' }, newFiles: { 'x.graphql': 'extend enum E { B C }\nextend type Query implements N { b: Int }\ninterface N { b: Int }\n' } },
  );
  // N is new too: implementing it reaches no client yet.
  assert.deepEqual(ids(r).sort(), ['info:enum-value-added', 'info:interface-implementation-added', 'info:type-added']);
  // The main file's own `extend` of a type defined in a sibling.
  const r2 = diff('extend type A { b: Int }\ntype Query { a: A }\n', 'extend type A { b: Int! }\ntype Query { a: A }\n', { files: { 'a.graphql': 'type A { a: Int }' } });
  assert.deepEqual(ids(r2), ['info:field-became-non-null']);
});

test('split schemas: files with only queries are left out, a sibling that does not parse is a warning', () => {
  const r = diff(Q, Q, { oldFiles: { 'q.graphql': 'query Q { x }', 'bad.graphql': 'type {' }, newFiles: { 'q.graphql': 'query Q { x }', 'bad.graphql': 'type B {}' } });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(ids(r), []);
  assert.deepEqual(r.files.old, ['/api/old/schema.graphql']);
  assert.equal(r.warnings.length, 2, r.warnings.join('|'));
  assert.match(r.warnings[0], /^Old: bad\.graphql was left out: .*\(line 1\)\.$/);
  assert.match(r.warnings[1], /^New: bad\.graphql was left out/);
});

test('definitions seen twice: the first is used and a warning says so', () => {
  const r = diff(Q, Q, { newFiles: { 'a.graphql': 'type A { a: Int }', 'b.graphql': 'type A { b: Int }\ntype B { b: Int }' } });
  assert.deepEqual(ids(r).sort(), ['info:type-added', 'info:type-added']);
  assert.deepEqual(r.warnings, ['New: Object type `A` is defined again at b.graphql:1; the first definition is used.']);
  assert.deepEqual([...only(r, 'type-added')].map((c) => c.message), ['Object type `A` added', 'Object type `B` added']);
  // A file that defines the main file's root types again is another version of the schema
  // (`schema-v2.graphql` next to `schema.graphql`): left out, and a note says so.
  const versions = diff(Q, Q, { files: { 'schema-v2.graphql': 'type Query { x: Int y: Int }\ntype Extra { e: Int }', 'old.graphql': 'schema { query: Query }\ntype Query { x: Int }' } });
  assert.deepEqual(ids(versions), []);
  assert.deepEqual(versions.warnings, ['Old: old.graphql, schema-v2.graphql were left out as another version of the schema: they define `Query` again. The `schemaFiles` setting names the files that belong to it.', 'New: old.graphql, schema-v2.graphql were left out as another version of the schema: they define `Query` again. The `schemaFiles` setting names the files that belong to it.']);
  assert.deepEqual(versions.files.new, ['/api/new/schema.graphql']);
  // One that only repeats a definition of the main file is a part of it, the repeat reported:
  // its other types are not taken for removed.
  const common = { 'common.graphql': 'scalar DateTime\ntype Address { city: String }\nextend type Query { addr: Address }' };
  const part = diff('type Query { a: Int }', 'type Query { a: Int }\nscalar DateTime', { files: common });
  assert.deepEqual(ids(part), []);
  assert.deepEqual(part.warnings, ['New: Scalar `DateTime` is defined again at common.graphql:1; the first definition is used.']);
  // Extending what the main file defines is a part of it.
  assert.deepEqual(ids(diff(Q, Q, { newFiles: { 'more.graphql': 'extend type Query { y: Int }' } })), ['info:field-added']);
  // A definition after an orphan extension completes it: no warning.
  const ok = diff(Q + 'extend type A { b: Int }\ntype A { a: Int }', Q + 'type A { a: Int b: Int }');
  assert.deepEqual(ids(ok), []);
  assert.deepEqual(ok.warnings, []);
  // Extending as another kind: left out, with a warning.
  const bad = diff(Q + 'type A { a: Int }\nextend interface A { b: Int }', Q + 'type A { a: Int }');
  assert.deepEqual(ids(bad), []);
  assert.deepEqual(bad.warnings, ['Old: `A` is an object type, but schema.graphql:3 extends it as an interface; that part is left out.']);
  // A field twice in one type.
  assert.match(diff(Q, 'type Query { x: Int x: String }').warnings[0], /Field `Query.x` is defined again/);
});

test('malformed input: the main file not parsing is an error with a position; not a schema at all', () => {
  const r = diff('type Query {\n  x: Int\n  y: \n}', Q);
  assert.deepEqual(ids(r), []);
  assert.equal(r.errors.old.file, '/api/old/schema.graphql');
  assert.equal(r.errors.old.line, 3);
  assert.match(r.errors.old.message, /Expected Name, found "}"/);
  assert.equal(r.errors.new, undefined);
  const q = diff('query { x }', Q);
  assert.equal(q.errors.old.message, 'schema.graphql has no type definitions (only queries or fragments).');
  assert.deepEqual(diff('', Q).errors.old.line, 0);
});

// --- introspection -----------------------------------------------------------------------

const SDL = `"""The root."""
type Query {
  "A user."
  user(id: ID!, strict: Boolean = false): User
  users(first: Int = 10, after: String): [User!]! @deprecated(reason: "use search")
  search(term: String!): [SearchResult!]!
}
"""A person."""
type User implements Node {
  id: ID!
  name: String
  role: Role @deprecated
  tags: [String!]
}
interface Node { id: ID! }
union SearchResult = User | Post
type Post implements Node { id: ID! title: String! }
enum Role { ADMIN USER @deprecated(reason: "no users") }
input UserInput @oneOf { byId: ID byName: String }
input Filter { "A tag." tag: String = "x" legacy: Boolean @deprecated(reason: "old") }
scalar DateTime @specifiedBy(url: "https://a")
directive @auth(role: Role = USER) repeatable on FIELD_DEFINITION | OBJECT
type Mutation { update(input: UserInput!, filter: Filter): User }
`;

const introspection = (sdl, wrap = false) => {
  const schema = graphql.buildSchema(sdl);
  const i = graphql.introspectionFromSchema(schema, { descriptions: true, specifiedByUrl: true, directiveIsRepeatable: true, schemaDescription: true, inputValueDeprecation: true, oneOf: true });
  return JSON.stringify(wrap ? { data: i } : i, null, 2);
};

test('introspection: the same schema as JSON and as SDL has no changes, either way round', () => {
  const json = introspection(SDL);
  const r = diff(json, SDL);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(ids(r), []);
  assert.deepEqual(ids(diff(SDL, json)), []);
  assert.deepEqual(ids(diff(introspection(SDL, true), SDL)), [], 'wrapped in data');
  assert.deepEqual(ids(diff(json, introspection(SDL, true))), [], 'introspection against introspection');
  assert.equal(r.info.old.kind, 'introspection');
  assert.equal(r.info.new.kind, 'sdl');
  assert.equal(r.info.old.types, r.info.new.types);
});

test('introspection: changes point into the JSON at the type, field, argument, value or directive', () => {
  const json = introspection(SDL);
  const changed = SDL.replace('name: String\n', 'name: String!\n')
    .replace('ADMIN USER', 'ADMIN')
    .replace('strict: Boolean = false', 'strict: Boolean = true')
    .replace('byId: ID byName', 'byName')
    .replace('role: Role = USER', 'role: Role = ADMIN')
    .replace('type Post', 'type Article')
    .replace('User | Post', 'User | Article');
  const r = diff(json, changed);
  const lines = json.split('\n');
  const at = (loc) => lines[loc.line].trim();
  const c = (id) => only(r, id)[0];
  assert.equal(at(c('field-became-non-null').old), '"name": "name",');
  assert.equal(at(c('deprecated-enum-value-removed').old), '"name": "USER",');
  assert.equal(at(c('argument-default-changed').old), '"name": "strict",');
  assert.equal(at(c('input-field-removed').old), '"name": "byId",');
  assert.equal(at(c('directive-argument-default-changed').old), '"name": "role",');
  assert.equal(at(c('type-removed').old), '"name": "Post",');
  assert.equal(at(c('union-member-removed').old), '"name": "SearchResult",');
  for (const x of r.changes) if (x.old) assert.equal(x.old.file, '/api/old/schema.graphql');
  // The same lines are found in the compact form that `graphql-codegen` writes.
  const compact = JSON.stringify(JSON.parse(json));
  const r2 = diff(compact, changed);
  assert.equal(only(r2, 'field-became-non-null')[0].old.line, 0);
  assert.ok(compact.slice(only(r2, 'field-became-non-null')[0].old.col).startsWith('"name":"name"'));
});

test('introspection: bad JSON, no __schema, or a result that can not be built, each say so', () => {
  assert.match(diff('{"__schema": ', Q).errors.old.message, /^schema\.graphql is not valid JSON/);
  assert.equal(diff('{"data": {"something": 1}}', Q).errors.old.message, 'schema.graphql has no `__schema` object in it.');
  assert.match(diff('{"__schema": {"types": [], "queryType": {"name": "Nope"}}}', Q).errors.old.message, /can't be read/);
});

test('glob matcher: ** and * and braces, relative to the folder', () => {
  const m = (p) => core.globMatcher(p);
  assert.ok(m('**/*.graphql')('a.graphql'));
  assert.ok(m('**/*.graphql')('types/deep/a.graphql'));
  assert.ok(!m('**/*.graphql')('a.gql'));
  assert.ok(m('*.graphql')('a.graphql'));
  assert.ok(!m('*.graphql')('types/a.graphql'));
  assert.ok(m('types/**')('types/a.graphql'));
  assert.ok(m('types/**')('types/x/y.graphqls'));
  assert.ok(!m('types/**')('other/a.graphql'));
  assert.ok(m('{*.graphql,*.graphqls}')('a.graphqls'));
  assert.ok(m('**/*.{graphql,gql}')('x/a.gql'));
  assert.ok(m('./**/*.graphql')('a.graphql'));
  assert.ok(m('a?.graphql')('a1.graphql'));
  assert.ok(!m('a?.graphql')('a/.graphql'));
  assert.ok(!m('')('a.graphql'));
  assert.ok(m('**.graphql')('x/y/a.graphql'));
  assert.ok(m('types/**/deep/*.graphql')('types/a/b/deep/c.graphql'));
  assert.ok(!m('types/**/deep/*.graphql')('types/a/b/c.graphql'));
  // Many stars against a long name that almost matches: no backtracking for ever.
  const t = Date.now();
  assert.ok(!m('*a*a*a*a*a*a*a*a*a*a*b.graphql')('a'.repeat(250) + '.graphql'));
  assert.ok(!m('**/**/**/**/**/**/**/x/**/**/**/y')(Array(200).fill('x').join('/')));
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
  assert.ok(core.isSafeGlob('**/*.graphql'));
  assert.ok(!core.isSafeGlob('../**/*.graphql'));
  assert.ok(!core.isSafeGlob('/etc/**'));
});

test('typeStr and valueStr', () => {
  const doc = graphql.parse('type Q { f(a: [Int!]! = [1, 2], o: I = {b: "x", a: 1.5}, e: E = X, n: Int = null, b: Boolean = true): [[String]!] }');
  const f = doc.definitions[0].fields[0];
  assert.equal(core.typeStr(f.type), '[[String]!]');
  assert.deepEqual(
    f.arguments.map((a) => core.valueStr(a.defaultValue)),
    ['[1, 2]', '{a: 1.5, b: "x"}', 'X', 'null', 'true'],
  );
});

test('removals: anchored on the closest part of the new schema that is still there', () => {
  const a = 'type Query {\n  a: Int\n  b(x: Int, y: Int): Int\n}\n\nenum E {\n  A\n  B\n}\n\ninput I {\n  p: Int\n  q: Int\n}\n\ntype Gone {\n  g: Int\n}\n\ndirective @d on FIELD_DEFINITION\n';
  const b = 'type Query {\n  b(x: Int): Int\n}\n\nenum E {\n  A\n}\n\ninput I {\n  p: Int\n}\n';
  const r = diff(a, b);
  const anchor = (id) => {
    const c = only(r, id)[0];
    assert.equal(c.new, undefined, id);
    return c.anchor && [c.anchor.line, c.anchor.col];
  };
  assert.deepEqual(anchor('field-removed'), [0, 5], 'on type Query');
  assert.deepEqual(anchor('argument-removed'), [1, 2], 'on the field b');
  assert.deepEqual(anchor('enum-value-removed'), [4, 5], 'on enum E');
  assert.deepEqual(anchor('input-field-removed'), [8, 6], 'on input I');
  assert.deepEqual(anchor('type-removed'), [0, 0], 'the top of the file it was in');
  assert.deepEqual(anchor('directive-removed'), [0, 0]);
  // With a schema block, a removed type points at it.
  const s = diff('schema { query: Query }\ntype Query { a: Int }\ntype T { t: Int }', '\nschema { query: Query }\ntype Query { a: Int }');
  assert.deepEqual([s.changes[0].anchor.line, s.changes[0].anchor.col], [1, 0]);
  // Everything else has its own new position and no anchor.
  for (const c of diff(Q, 'type Query { x: Int, y: Int }').changes) assert.equal(c.anchor, undefined);
});

test('introspection without the optional parts: nothing it does not say is taken for a change', () => {
  const sdl = 'type Query { a(x: Int, old: Int @deprecated(reason: "no")): Int, b(i: I): Int }\ninput I @oneOf { a: Int, b: String, c: Int @deprecated }\ndirective @tag(name: String) repeatable on FIELD_DEFINITION\nscalar Url @specifiedBy(url: "https://example.com")\ntype T { u: Url }';
  const schema = graphql.buildSchema(sdl);
  const bare = JSON.stringify(graphql.introspectionFromSchema(schema, { oneOf: false, directiveIsRepeatable: false, inputValueDeprecation: false, specifiedByUrl: false }));
  const full = JSON.stringify(graphql.introspectionFromSchema(schema, { oneOf: true, directiveIsRepeatable: true, inputValueDeprecation: true, specifiedByUrl: true }));
  for (const [o, n] of [
    [bare, sdl],
    [sdl, bare],
    [bare, full],
    [full, bare],
  ]) {
    const r = diff(o, n);
    assert.deepEqual(ids(r), [], 'no changes');
    assert.equal(r.warnings.length, 4, r.warnings.join('\n'));
    assert.ok(r.warnings.some((w) => /introspection result has no `isOneOf`.*`@oneOf` on input types was not compared/.test(w)));
    assert.ok(r.warnings.some((w) => /`isDeprecated` on arguments and input fields.*deprecated arguments and input fields were not compared/.test(w)));
  }
  assert.match(diff(bare, sdl).warnings[0], /^The old introspection result/);
  // A full introspection result compares everything, without warnings.
  const r = diff(full, sdl.replace(' @oneOf', '').replace(' repeatable', ''));
  assert.deepEqual(ids(r).sort(), ['error:directive-repeatable-removed', 'info:input-one-of-removed']);
  assert.deepEqual(r.warnings, []);
  // A real difference that the bare result can still tell is still reported.
  assert.deepEqual(ids(diff(bare, sdl.replace('a: Int, b: String', 'a: Int'))), ['error:input-field-removed']);
  // Deprecating an argument or input field leaves it out of a bare result: not a breaking removal.
  const before = 'type Query { a(x: Int, y: Int): Int }\ninput F { p: Int q: Int }\ntype T { f(i: F): Int }';
  const after = before.replace('x: Int,', 'x: Int @deprecated(reason: "use y"),').replace('q: Int', 'q: Int @deprecated');
  const bareOf = (s) => JSON.stringify(graphql.introspectionFromSchema(graphql.buildSchema(s), { inputValueDeprecation: false }));
  for (const old of [bareOf(before), before]) {
    const d = diff(old, bareOf(after));
    assert.deepEqual(ids(d).sort(), ['warning:argument-removed', 'warning:input-field-removed']);
    assert.match(only(d, 'argument-removed')[0].message, /removed, or deprecated: the new introspection result leaves deprecated arguments out/);
    assert.ok(d.warnings.some((w) => /introspection result has no `isDeprecated`/.test(w)), d.warnings.join('\n'));
  }
});

test('built-in scalars and directives written out are not part of the comparison', () => {
  const builtins = 'scalar String\nscalar Int\nscalar Boolean\nscalar Float\nscalar ID\ndirective @deprecated(reason: String = "No longer supported") on FIELD_DEFINITION | ENUM_VALUE\ndirective @skip(if: Boolean!) on FIELD | FRAGMENT_SPREAD | INLINE_FRAGMENT\ndirective @include(if: Boolean!) on FIELD | FRAGMENT_SPREAD | INLINE_FRAGMENT\ndirective @specifiedBy(url: String!) on SCALAR\ndirective @oneOf on INPUT_OBJECT\n';
  const sdl = 'type Query { a: String @deprecated, b: Int }';
  assert.deepEqual(ids(diff(builtins + sdl, sdl)), []);
  assert.deepEqual(ids(diff(sdl, builtins + sdl)), []);
  const json = JSON.stringify(graphql.introspectionFromSchema(graphql.buildSchema(builtins + sdl)));
  assert.deepEqual(ids(diff(builtins + sdl, json)), []);
  assert.equal(diff(builtins + sdl, sdl).info.old.types, 1);
});

test('defaults are compared as the server coerces them', () => {
  const sdl = 'type Query { a(y: Float = 2.0, z: [Int] = 1, f: Float = 1, i: I = {n: 1, l: 3}): Int }\ninput I { n: Float, l: [Int] }';
  const codeFirst = new graphql.GraphQLSchema({
    query: new graphql.GraphQLObjectType({
      name: 'Query',
      fields: {
        a: {
          type: graphql.GraphQLInt,
          args: {
            y: { type: graphql.GraphQLFloat, defaultValue: 2 },
            z: { type: new graphql.GraphQLList(graphql.GraphQLInt), defaultValue: [1] },
            f: { type: graphql.GraphQLFloat, defaultValue: 1.0 },
            i: { type: graphql.buildSchema(sdl).getType('I'), defaultValue: { n: 1.0, l: [3] } },
          },
        },
      },
    }),
  });
  const json = JSON.stringify(graphql.introspectionFromSchema(codeFirst));
  assert.deepEqual(ids(diff(sdl, json)), []);
  assert.deepEqual(ids(diff(json, sdl)), []);
  assert.deepEqual(ids(diff(sdl, sdl.replace('f: Float = 1', 'f: Float = 1.0'))), []);
  // A real change still is one, and says it as written.
  const r = diff(sdl, sdl.replace('y: Float = 2.0', 'y: Float = 2.5'));
  assert.deepEqual(ids(r), ['warning:argument-default-changed']);
  assert.match(r.changes[0].message, /`2\.0` → `2\.5`/);
  assert.deepEqual(ids(diff(sdl, sdl.replace('z: [Int] = 1', 'z: [Int] = [1, 2]'))), ['warning:argument-default-changed']);
  // An ID or String default is not a number, whatever it looks like.
  assert.deepEqual(ids(diff('type Query { a(x: ID = 1): Int }', 'type Query { a(x: ID = 1.0): Int }')), ['warning:argument-default-changed']);
});

test('decodeText: UTF-16 by its byte order mark, else UTF-8', () => {
  const text = 'type Query { é: Int }';
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const be = Buffer.from(le.subarray(2)).swap16();
  assert.equal(core.decodeText(le), text);
  assert.equal(core.decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), text);
  assert.equal(core.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])), text);
  assert.equal(core.decodeText(Buffer.from(text)), text);
});

test('split schemas: a part that declares the main file\'s scalars again is merged, not taken for another version', () => {
  const main = 'type Query { me: User }\nscalar DateTime\nscalar JSON';
  const r = diff(main, main, {
    oldFiles: { 'user.graphql': 'scalar DateTime\ntype User { id: ID, at: DateTime, meta: String }' },
    newFiles: { 'user.graphql': 'scalar DateTime\nscalar JSON\ntype User { id: ID, at: DateTime, meta: JSON }' },
  });
  assert.deepEqual(ids(r), ['error:field-type-changed']);
  assert.ok(!r.warnings.some((w) => /another version/.test(w)), r.warnings.join('\n'));
});

test('introspection from graphql-js 15: specifiedByUrl is read like specifiedByURL', () => {
  const sdl = 'type Query { d: DateTime }\nscalar DateTime @specifiedBy(url: "https://tools.ietf.org/html/rfc3339")';
  const v16 = graphql.introspectionFromSchema(graphql.buildSchema(sdl), { specifiedByUrl: true });
  const v15 = JSON.parse(JSON.stringify(v16));
  for (const t of v15.__schema.types) if ('specifiedByURL' in t) {
    t.specifiedByUrl = t.specifiedByURL;
    delete t.specifiedByURL;
  }
  for (const [o, n] of [[JSON.stringify(v15), JSON.stringify(v16)], [sdl, JSON.stringify(v15)], [JSON.stringify(v15), sdl]]) {
    const r = diff(o, n);
    assert.deepEqual(ids(r), []);
    assert.deepEqual(r.warnings, []);
  }
});

test('the load cache keeps each side\'s own warnings', () => {
  const T = 'type Query { x: Int }';
  const P = '/cache/schema.graphql';
  assert.deepEqual(core.compare({ text: T, path: P }, { text: T, path: P, warnings: ['Only some files were read.'] }).warnings, ['New: Only some files were read.']);
  assert.deepEqual(core.compare({ text: T, path: P }, { text: T, path: P }).warnings, []);
});

test('the default schemaFiles pattern names .graphqls and .gql files too', () => {
  const pkg = JSON.parse(createRequire(import.meta.url)('node:fs').readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const glob = pkg.contributes.configuration.properties['graphqlBreakingChanges.schemaFiles'].default;
  assert.ok(core.isSafeGlob(glob));
  for (const f of ['types.graphqls', 'a/b.gql', 'c.graphql']) assert.ok(core.globMatcher(glob)(f), f);
  assert.ok(!core.globMatcher(glob)('schema.json'));
});
