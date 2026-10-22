// Every rule, from both directions where the reverse is another rule, plus the
// nullability matrix, interfaces, directives and federation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { core, diff, ids, levelChecks, only, pair, produced, withDirective, withField, withInput } from './helpers.mjs';

const Q = 'type Query { x: Int }\n';

// --- schema ------------------------------------------------------------------------------

test('schema: root types changed, removed, added', () => {
  pair('schema { query: Query }\ntype Query { x: Int }\ntype Root { x: Int }', 'schema { query: Root }\ntype Query { x: Int }\ntype Root { x: Int }', ['error:schema-root-changed'], ['error:schema-root-changed']);
  pair('schema { query: Query mutation: Mutation }\ntype Query { x: Int }\ntype Mutation { y: Int }', 'schema { query: Query }\ntype Query { x: Int }\ntype Mutation { y: Int }', ['error:schema-root-removed'], ['info:schema-root-added']);
  // Default names: a root that went with its type is the type's change only.
  pair('type Query { x: Int }\ntype Mutation { y: Int }', 'type Query { x: Int }', ['error:type-removed'], ['info:type-added']);
  // Default names made explicit, or the other way round: no change.
  assert.deepEqual(ids(diff('type Query { x: Int }\ntype Mutation { y: Int }', 'schema { query: Query mutation: Mutation }\ntype Query { x: Int }\ntype Mutation { y: Int }')), []);
  // A subscription root added with its type, declared in the schema block: both are reported.
  const r = diff('schema { query: Query }\ntype Query { x: Int }', 'schema { query: Query subscription: Sub }\ntype Query { x: Int }\ntype Sub { s: Int }');
  assert.deepEqual(ids(r).sort(), ['info:schema-root-added', 'info:type-added']);
  assert.match(only(r, 'schema-root-added')[0].message, /Subscription root type `Sub` added/);
});

test('schema: description and directives', () => {
  pair('"""A"""\nschema { query: Query }\ntype Query { x: Int }', '"""B"""\nschema { query: Query }\ntype Query { x: Int }', ['info:schema-description-changed'], ['info:schema-description-changed']);
  pair(Q, Q + 'extend schema @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key"])', ['info:directive-usage-added'], ['info:directive-usage-removed']);
  const r = diff(Q + 'extend schema @link(url: "a")', Q + 'extend schema @link(url: "b")');
  assert.deepEqual(ids(r), ['info:directive-usage-changed']);
  assert.equal(r.changes[0].message, '`@link(url: "a")` on the schema is now `@link(url: "b")`');
});

// --- types -------------------------------------------------------------------------------

test('types: added, removed, kind changed, description', () => {
  pair(Q, Q + 'type A { a: Int }', ['info:type-added'], ['error:type-removed']);
  pair(Q + 'enum E { A }', Q, ['error:type-removed'], ['info:type-added']);
  const r = diff(Q + 'type A { a: Int }', Q + 'interface A { a: Int }');
  assert.deepEqual(ids(r), ['error:type-kind-changed']);
  assert.equal(r.changes[0].message, '`A` changed from an object type to an interface');
  assert.deepEqual(ids(diff(Q + 'enum A { X }', Q + 'scalar A')), ['error:type-kind-changed']);
  pair(Q + '"""old"""\ntype A { a: Int }', Q + '"""new"""\ntype A { a: Int }', ['info:type-description-changed'], ['info:type-description-changed']);
  const d = diff(Q + 'type A { a: Int }', Q + '"""doc"""\ntype A { a: Int }');
  assert.equal(d.changes[0].message, 'Description of object type `A` added');
  // Whitespace around a description is not a change.
  assert.deepEqual(ids(diff(Q + '"""\n  doc\n"""\ntype A { a: Int }', Q + '"doc"\ntype A { a: Int }')), []);
});

test('types: every kind is named in messages', () => {
  const kinds = { 'type A { a: Int }': 'Object type', 'interface A { a: Int }': 'Interface', 'union A = Query': 'Union', 'enum A { X }': 'Enum', 'input A { a: Int }': 'Input type', 'scalar A': 'Scalar' };
  for (const [def, word] of Object.entries(kinds)) assert.equal(only(diff(Q, Q + def), 'type-added')[0].message, `${word} \`A\` added`, def);
});

test('scalars: @specifiedBy added, removed, changed', () => {
  pair(Q + 'scalar D', Q + 'scalar D @specifiedBy(url: "https://a")', ['info:scalar-specified-by-changed'], ['info:scalar-specified-by-changed']);
  const r = diff(Q + 'scalar D @specifiedBy(url: "https://a")', Q + 'scalar D @specifiedBy(url: "https://b")');
  assert.equal(r.changes[0].message, '`@specifiedBy` of scalar `D` changed from `https://a` to `https://b`');
});

// --- fields ------------------------------------------------------------------------------

test('fields: added, removed, deprecated removed', () => {
  pair(withField('x: Int'), withField('x: Int y: String'), ['info:field-added'], ['error:field-removed']);
  pair(withField('x: Int y: String @deprecated(reason: "gone")'), withField('x: Int'), ['warning:deprecated-field-removed'], ['info:field-added']);
  const r = diff(withField('x: Int y: String @deprecated(reason: "gone")'), withField('x: Int'));
  assert.equal(r.changes[0].message, 'Deprecated field `Query.y` removed (deprecated: `gone`)');
  assert.equal(diff(withField('x: Int'), withField('x: Int y: String @deprecated')).changes[0].message, 'Field `Query.y` added (deprecated)');
});

test('fields: the nullability matrix for what the client reads', () => {
  const cases = [
    // old, new, forward, backward
    ['String', 'String!', 'info:field-became-non-null', 'error:field-became-nullable'],
    ['[String]', '[String!]', 'info:field-became-non-null', 'error:field-became-nullable'],
    ['[String]', '[String]!', 'info:field-became-non-null', 'error:field-became-nullable'],
    ['[String]', '[String!]!', 'info:field-became-non-null', 'error:field-became-nullable'],
    ['[String!]!', '[String]!', 'error:field-became-nullable', 'info:field-became-non-null'],
    ['[[String!]!]!', '[[String]!]!', 'error:field-became-nullable', 'info:field-became-non-null'],
    // Mixed: the bad direction wins, both ways.
    ['[String!]', '[String]!', 'error:field-became-nullable', 'error:field-became-nullable'],
    // Another type, or other nesting: a type change.
    ['String', 'Int', 'error:field-type-changed', 'error:field-type-changed'],
    ['String', '[String]', 'error:field-type-changed', 'error:field-type-changed'],
    ['[String]', '[[String]]', 'error:field-type-changed', 'error:field-type-changed'],
    ['String!', '[String!]!', 'error:field-type-changed', 'error:field-type-changed'],
  ];
  for (const [o, n, f, b] of cases) pair(withField(`x: ${o}`), withField(`x: ${n}`), [f], [b], `${o} → ${n}`);
  assert.deepEqual(ids(diff(withField('x: [String!]!'), withField('x: [ String! ]!'))), [], 'spacing');
  const r = diff(withField('x: [String!]'), withField('x: [String]'));
  assert.equal(r.changes[0].message, 'Field `Query.x` can now hold `null`: `[String!]` → `[String]`');
  assert.equal(diff(withField('x: String!'), withField('x: String')).changes[0].message, 'Field `Query.x` can now be `null`: `String!` → `String`');
  assert.equal(diff(withField('x: Int'), withField('x: String')).changes[0].message, 'Field `Query.x` changed type: `Int` → `String`');
});

test('fields: deprecation added, removed, reason changed; default reason', () => {
  pair(withField('x: Int'), withField('x: Int @deprecated(reason: "no")'), ['info:field-deprecated'], ['info:field-deprecation-removed']);
  pair(withField('x: Int @deprecated(reason: "a")'), withField('x: Int @deprecated(reason: "b")'), ['info:field-deprecation-reason-changed'], ['info:field-deprecation-reason-changed']);
  assert.deepEqual(ids(diff(withField('x: Int @deprecated'), withField('x: Int @deprecated(reason: "No longer supported")'))), []);
  const r = diff(withField('x: Int @deprecated'), withField('x: Int @deprecated(reason: "use y")'));
  assert.equal(r.changes[0].message, 'Deprecation reason of field `Query.x` changed: `No longer supported` → `use y`');
  assert.equal(diff(withField('x: Int'), withField('x: Int @deprecated(reason: "no")')).changes[0].message, 'Field `Query.x` deprecated: `no`');
});

test('fields: description', () => {
  pair(withField('"a" x: Int'), withField('"b" x: Int'), ['info:field-description-changed'], ['info:field-description-changed']);
  assert.equal(diff(withField('x: Int'), withField('"doc" x: Int')).changes[0].message, 'Description of field `Query.x` added');
  // Re-wrapped by a printer (GitHub's schema.json against its schema.graphql): not a change.
  assert.deepEqual(ids(diff(withField('"""\n  The commit message. If a merge queue is required by\n  the base branch, this value is set by it.\n  """\n  x: Int'), withField('"The commit message. If a merge queue is required by the base branch, this value is set by it."\n  x: Int'))), []);
});

// --- arguments, input fields, directive arguments ----------------------------------------

/** The three places an input value lives, each as a function of the value's definition. */
const INPUTS = {
  argument: (v) => withField(v ? `x(${v}): Int` : 'x: Int'),
  // An input object needs a field: `b` is on both sides.
  'input-field': (v) => withInput(`b: Int${v ? ` ${v}` : ''}`),
  'directive-argument': (v) => withDirective(v),
};
const id = (p, rule) => core.inputId(p, rule);

test('input values: added (optional, with a default, required), removed, deprecated removed', () => {
  for (const [p, at] of Object.entries(INPUTS)) {
    pair(at(''), at('a: Int'), [`info:${id(p, 'added')}`], [`error:${id(p, 'removed')}`], p);
    pair(at(''), at('a: Int = 1'), [`warning:${id(p, 'added')}`], [`error:${id(p, 'removed')}`], p);
    pair(at(''), at('a: Int!'), [`error:${id(p, 'added-required')}`], [`error:${id(p, 'removed')}`], p);
    pair(at(''), at('a: Int! = 1'), [`warning:${id(p, 'added')}`], [`error:${id(p, 'removed')}`], p);
    pair(at('a: Int @deprecated'), at(''), [`warning:${id(p, 'deprecated-removed')}`], [`info:${id(p, 'added')}`], p);
  }
  // An empty input object isn't valid SDL: the input-field case above uses the empty-ish form.
  const r = diff(withInput('b: Int'), withInput('b: Int a: Int!'));
  assert.equal(r.changes[0].message, 'Required input field `I.a` added: `Int!`');
  assert.equal(diff(withField('x: Int'), withField('x(a: Int = 1): Int')).changes[0].message, "Argument `a` of `Query.x` added with default `1`: the server now applies it for clients that don't send it");
  assert.equal(diff(withDirective(''), withDirective('a: Int!')).changes[0].message, 'Required argument `a` of directive `@d` added: `Int!`');
});

test('input values: the nullability matrix for what the client sends', () => {
  for (const [p, at] of Object.entries(INPUTS)) {
    const cases = [
      ['a: Int', 'a: Int!', [`error:${id(p, 'became-required')}`], [`info:${id(p, 'became-nullable')}`]],
      ['a: Int = 1', 'a: Int! = 1', [`error:${id(p, 'became-non-null')}`], [`info:${id(p, 'became-nullable')}`]],
      ['a: Int', 'a: Int! = 1', [`warning:${id(p, 'became-non-null')}`], [`info:${id(p, 'became-nullable')}`, `warning:${id(p, 'default-removed')}`]],
      ['a: [Int]', 'a: [Int!]', [`error:${id(p, 'became-non-null')}`], [`info:${id(p, 'became-nullable')}`]],
      ['a: [Int]!', 'a: [Int!]!', [`error:${id(p, 'became-non-null')}`], [`info:${id(p, 'became-nullable')}`]],
      ['a: [Int]', 'a: [Int]!', [`error:${id(p, 'became-required')}`], [`info:${id(p, 'became-nullable')}`]],
      ['a: Int', 'a: String', [`error:${id(p, 'type-changed')}`], [`error:${id(p, 'type-changed')}`]],
      ['a: Int', 'a: [Int]', [`error:${id(p, 'type-changed')}`], [`error:${id(p, 'type-changed')}`]],
      ['a: [Int!]', 'a: [Int]!', [`error:${id(p, 'became-required')}`], [`error:${id(p, 'became-non-null')}`]],
    ];
    for (const [o, n, f, b] of cases) pair(at(o), at(n), f, b, `${p} ${o} → ${n}`);
  }
  assert.equal(diff(withField('x(a: Int): Int'), withField('x(a: Int!): Int')).changes[0].message, 'Argument `a` of `Query.x` became required: `Int` → `Int!`');
  assert.equal(diff(withField('x(a: Int): Int'), withField('x(a: Int! = 3): Int')).changes[0].message, 'Argument `a` of `Query.x` became non-null: `Int` → `Int!`, with default `3` (clients sending `null` break)');
  assert.equal(diff(withField('x(a: [Int]): Int'), withField('x(a: [Int!]): Int')).changes[0].message, 'Argument `a` of `Query.x` no longer accepts `null` items: `[Int]` → `[Int!]`');
  assert.equal(diff(withField('x(a: Int!): Int'), withField('x(a: Int): Int')).changes[0].message, 'Argument `a` of `Query.x` became nullable: `Int!` → `Int`');
  assert.equal(diff(withInput('a: Int'), withInput('a: Int!')).changes[0].message, 'Input field `I.a` became required: `Int` → `Int!`');
});

test('input values: default added, changed, removed; required ones', () => {
  for (const [p, at] of Object.entries(INPUTS)) {
    pair(at('a: Int'), at('a: Int = 1'), [`warning:${id(p, 'default-added')}`], [`warning:${id(p, 'default-removed')}`], p);
    pair(at('a: Int = 1'), at('a: Int = 2'), [`warning:${id(p, 'default-changed')}`], [`warning:${id(p, 'default-changed')}`], p);
    // A required value gets a default: clients always sent it, so nothing changes for them.
    pair(at('a: Int!'), at('a: Int! = 1'), [`info:${id(p, 'default-added')}`], [`error:${id(p, 'became-required')}`], p);
  }
  assert.equal(diff(withField('x(a: Int = 1): Int'), withField('x(a: Int): Int')).changes[0].message, "Default `1` of argument `a` of `Query.x` removed: clients that don't send it now send `null`");
  assert.equal(diff(withField('x(a: Int! = 1): Int'), withField('x(a: Int!): Int')).changes[0].message, 'Argument `a` of `Query.x` became required: default `1` removed from `Int!`');
  assert.equal(diff(withField('x(a: Int!): Int'), withField('x(a: Int! = 1): Int')).changes[0].message, 'Default `1` added to argument `a` of `Query.x`: it is no longer required');
  // Object defaults compare by value, not key order; strings keep their quotes.
  assert.deepEqual(ids(diff(withInput('a: J = {x: 1, y: 2}') + 'input J { x: Int y: Int }', withInput('a: J = {y: 2, x: 1}') + 'input J { x: Int y: Int }')), []);
  assert.equal(diff(withField('x(a: String = "a"): Int'), withField('x(a: String = "b"): Int')).changes[0].message, 'Default of argument `a` of `Query.x` changed: `"a"` → `"b"`');
  assert.deepEqual(ids(diff(withField('x(a: [Int] = [1, 2]): Int'), withField('x(a: [Int] = [2, 1]): Int'))), [`warning:argument-default-changed`], 'list order matters');
  // Input fields left out of an object default get their own default from the server.
  const io = (d) => `input I { f: Int = 3, g: Int }\ntype Query { a(x: I = ${d}): Int }`;
  assert.deepEqual(ids(diff(io('{}'), io('{f: 3}'))), []);
  assert.deepEqual(ids(diff(io('{g: 1}'), io('{f: 3, g: 1}'))), []);
  assert.deepEqual(ids(diff(io('{}'), io('{f: 4}'))), ['warning:argument-default-changed']);
});

test('input values: deprecation and description', () => {
  for (const [p, at] of Object.entries(INPUTS)) {
    pair(at('a: Int'), at('a: Int @deprecated(reason: "r")'), [`info:${id(p, 'deprecated')}`], [`info:${id(p, 'deprecation-removed')}`], p);
    pair(at('a: Int @deprecated(reason: "a")'), at('a: Int @deprecated(reason: "b")'), [`info:${id(p, 'deprecation-reason-changed')}`], [`info:${id(p, 'deprecation-reason-changed')}`], p);
    pair(at('"a" a: Int'), at('"b" a: Int'), [`info:${id(p, 'description-changed')}`], [`info:${id(p, 'description-changed')}`], p);
  }
});

test('input objects: @oneOf', () => {
  pair(withInput('a: Int b: Int'), withInput('a: Int b: Int').replace('input I', 'input I @oneOf'), ['error:input-one-of-added'], ['info:input-one-of-removed']);
});

// --- enums -------------------------------------------------------------------------------

test('enums: a value added is dangerous when a field returns the enum, else info', () => {
  const out = (vals) => `type Query { x: E }\nenum E { ${vals} }`;
  const inp = (vals) => `type Query { x(e: E): Int }\nenum E { ${vals} }`;
  const unused = (vals) => `type Query { x: Int }\nenum E { ${vals} }`;
  pair(out('A'), out('A B'), ['warning:enum-value-added'], ['error:enum-value-removed']);
  pair(inp('A'), inp('A B'), ['info:enum-value-added'], ['error:enum-value-removed']);
  pair(unused('A'), unused('A B'), ['info:enum-value-added'], ['error:enum-value-removed']);
  // Returned inside a list, or by an interface field: still returned.
  assert.deepEqual(ids(diff('type Query { x: [E!]! }\nenum E { A }', 'type Query { x: [E!]! }\nenum E { A B }')), ['warning:enum-value-added']);
  assert.deepEqual(ids(diff('type Query { x: Int }\ninterface N { e: E }\nenum E { A }', 'type Query { x: Int }\ninterface N { e: E }\nenum E { A B }')), ['warning:enum-value-added']);
  assert.equal(diff(out('A'), out('A B')).changes[0].message, 'Enum value `E.B` added: fields return `E`, so clients with an exhaustive switch may break');
  assert.equal(diff(inp('A'), inp('A B')).changes[0].message, 'Enum value `E.B` added');
});

test('enums: deprecated value removed, deprecation, description', () => {
  const e = (vals) => `type Query { x: E }\nenum E { ${vals} }`;
  pair(e('A B @deprecated(reason: "old")'), e('A'), ['warning:deprecated-enum-value-removed'], ['warning:enum-value-added']);
  pair(e('A'), e('A @deprecated'), ['info:enum-value-deprecated'], ['info:enum-value-deprecation-removed']);
  pair(e('A @deprecated(reason: "x")'), e('A @deprecated(reason: "y")'), ['info:enum-value-deprecation-reason-changed'], ['info:enum-value-deprecation-reason-changed']);
  pair(e('"a" A'), e('"b" A'), ['info:enum-value-description-changed'], ['info:enum-value-description-changed']);
  assert.equal(diff(e('A B @deprecated(reason: "old")'), e('A')).changes[0].message, 'Deprecated enum value `E.B` removed (deprecated: `old`)');
});

// --- unions and interfaces ---------------------------------------------------------------

test('unions: members added and removed', () => {
  const u = (m) => `type Query { s: S }\ntype A { a: Int }\ntype B { b: Int }\nunion S = ${m}`;
  pair(u('A'), u('A | B'), ['warning:union-member-added'], ['error:union-member-removed']);
  assert.deepEqual(ids(diff(u('A | B'), u('B | A'))), [], 'order');
  assert.equal(diff(u('A'), u('A | B')).changes[0].message, '`B` added to union `S`: queries that cover every member no longer do');
  assert.equal(diff(u('A | B'), u('A')).changes[0].message, '`B` removed from union `S`');
  assert.equal(diff(u('A'), u('A | B')).changes[0].field, 'B');
});

test('interfaces: implementations added and removed, in any order', () => {
  const t = (impl) => `type Query { a: A }\ninterface N { id: ID! }\ninterface M { id: ID! }\ntype A${impl ? ` implements ${impl}` : ''} { id: ID! }`;
  pair(t('N'), t('N & M'), ['warning:interface-implementation-added'], ['error:interface-implementation-removed']);
  pair(t(''), t('N'), ['warning:interface-implementation-added'], ['error:interface-implementation-removed']);
  assert.deepEqual(ids(diff(t('N & M'), t('M & N'))), []);
  assert.equal(diff(t('N'), t('')).changes[0].message, 'Object type `A` no longer implements `N`: it is no longer returned where `N` is');
  // A new type implementing an existing interface reaches clients like a new union member.
  const node = 'type Query { n: Node }\ninterface Node { id: ID }\ntype A implements Node { id: ID }';
  const added = diff(node, node + '\ntype B implements Node { id: ID }');
  assert.deepEqual(ids(added).sort(), ['info:type-added', 'warning:interface-implementation-added']);
  assert.equal(only(added, 'interface-implementation-added')[0].message, 'New object type `B` implements `Node`: it can be returned where `Node` is');
  // Of a new interface, nobody could have covered every implementor.
  assert.deepEqual(ids(diff('type Query { x: Int }', 'type Query { x: Int }\ninterface N { id: ID }\ntype B implements N { id: ID }')), ['info:type-added', 'info:type-added']);
  // An interface implementing another is never returned in its place: info, not dangerous.
  const ifc = diff('type Query { x: Int }\ninterface N { id: ID! }\ninterface M { id: ID! }', 'type Query { x: Int }\ninterface N { id: ID! }\ninterface M implements N { id: ID! }');
  assert.deepEqual(ids(ifc), ['info:interface-implementation-added']);
  assert.equal(ifc.changes[0].message, 'Interface `M` now implements `N`');
  assert.equal(diff('type Query { x: Int }\ninterface N { id: ID! }\ninterface M implements N { id: ID! }', 'type Query { x: Int }\ninterface N { id: ID! }\ninterface M { id: ID! }').changes[0].message, 'Interface `M` no longer implements `N`');
  // An existing type implementing an interface that is itself new: no client can be querying it.
  const T = 'type Query { a: A }\ninterface A { x: Int }\ntype T implements A { x: Int }';
  const nb = diff(T, 'type Query { a: A }\ninterface A { x: Int }\ninterface B implements A { x: Int }\ntype T implements B & A { x: Int }');
  assert.deepEqual(ids(nb).sort(), ['info:interface-implementation-added', 'info:type-added']);
  // Nor is a new interface implementing an existing one.
  assert.deepEqual(ids(diff('type Query { x: Int }\ninterface N { id: ID! }', 'type Query { x: Int }\ninterface N { id: ID! }\ninterface M implements N { id: ID! }')), ['info:type-added']);
});

test('interfaces: a field change on an interface names its implementors, and shows on each of them', () => {
  const s = (t) => `type Query { n: N }\ninterface N { id: ID! x: ${t} }\ntype A implements N { id: ID! x: ${t} }\ntype B implements N { id: ID! x: ${t} }`;
  const r = diff(s('Int!'), s('Int'));
  assert.deepEqual(ids(r), ['error:field-became-nullable', 'error:field-became-nullable', 'error:field-became-nullable']);
  const onN = r.changes.find((c) => c.type === 'N');
  assert.equal(onN.message, 'Field `N.x` can now be `null`: `Int!` → `Int` (implemented by `A`, `B`)');
  assert.equal(onN.kind, 'INTERFACE');
  assert.deepEqual(r.changes.map((c) => c.type).sort(), ['A', 'B', 'N']);
  // Removed from the interface: the implementors it had are named.
  const removed = diff(s('Int'), `type Query { n: N }\ninterface N { id: ID! }\ntype A implements N { id: ID! x: Int }\ntype B implements N { id: ID! x: Int }`);
  assert.equal(removed.changes[0].message, 'Field `N.x` removed (implemented by `A`, `B`)');
  // Many implementors: the first few and a count.
  const many = (n, t) => `type Query { x: N }\ninterface N { x: ${t} }\n` + Array.from({ length: n }, (_, i) => `type T${i} implements N { x: ${t} }`).join('\n');
  assert.match(diff(many(5, 'Int!'), many(5, 'Int')).changes.find((c) => c.type === 'N').message, /implemented by `T0`, `T1`, `T2` and 2 more\)$/);
});

// --- directives --------------------------------------------------------------------------

test('directive definitions: added, removed, locations, repeatable, description', () => {
  pair(Q, Q + 'directive @d on FIELD', ['info:directive-added'], ['error:directive-removed']);
  pair(Q + 'directive @d on FIELD', Q + 'directive @d on FIELD | QUERY', ['info:directive-location-added'], ['error:directive-location-removed']);
  pair(Q + 'directive @d on FIELD', Q + 'directive @d repeatable on FIELD', ['info:directive-repeatable-added'], ['error:directive-repeatable-removed']);
  pair(Q + '"a" directive @d on FIELD', Q + '"b" directive @d on FIELD', ['info:directive-description-changed'], ['info:directive-description-changed']);
  assert.equal(diff(Q + 'directive @d on FIELD | QUERY', Q + 'directive @d on FIELD').changes[0].message, 'Directive `@d` can no longer be used on `QUERY`');
  assert.equal(diff(Q, Q + 'directive @d on FIELD').changes[0].type, '@d');
  assert.equal(diff(Q, Q + 'directive @d on FIELD').changes[0].kind, 'DIRECTIVE');
});

// --- directive usage ---------------------------------------------------------------------

test('directive usage: added, removed, changed, on every kind of thing', () => {
  const places = [
    ['type', (d) => `type Query { x: Int }\ntype A ${d} { a: Int }`, 'object type `A`'],
    ['field', (d) => `type Query { x: Int ${d} }`, 'field `Query.x`'],
    ['argument', (d) => `type Query { x(a: Int ${d}): Int }`, 'argument `a` of `Query.x`'],
    ['input field', (d) => `type Query { x(i: I): Int }\ninput I { a: Int ${d} }`, 'input field `I.a`'],
    ['enum value', (d) => `type Query { e: E }\nenum E { A ${d} }`, 'enum value `E.A`'],
    ['enum', (d) => `type Query { e: E }\nenum E ${d} { A }`, 'enum `E`'],
    ['scalar', (d) => `type Query { x: Int }\nscalar S ${d}`, 'scalar `S`'],
    ['interface', (d) => `type Query { x: Int }\ninterface N ${d} { id: ID! }`, 'interface `N`'],
    ['union', (d) => `type Query { x: Int }\ntype A { a: Int }\nunion U ${d} = A`, 'union `U`'],
    ['input object', (d) => `type Query { x(i: I): Int }\ninput I ${d} { a: Int }`, 'input type `I`'],
  ];
  for (const [what, at, name] of places) {
    pair(at(''), at('@tag(name: "a")'), ['info:directive-usage-added'], ['info:directive-usage-removed'], what);
    const r = diff(at('@tag(name: "a")'), at('@tag(name: "b")'));
    assert.deepEqual(ids(r), ['info:directive-usage-changed'], what);
    assert.equal(r.changes[0].message, `\`@tag(name: "a")\` on ${name} is now \`@tag(name: "b")\``, what);
    assert.equal(diff(at(''), at('@tag(name: "a")')).changes[0].message, `\`@tag(name: "a")\` added to ${name}`, what);
  }
  // Repeated directives: one more of them is one addition; argument order doesn't matter.
  assert.deepEqual(ids(diff(withField('x: Int @tag(name: "a")'), withField('x: Int @tag(name: "a") @tag(name: "b")'))), ['info:directive-usage-added']);
  assert.deepEqual(ids(diff(withField('x: Int @tag(a: 1, b: 2)'), withField('x: Int @tag(b: 2, a: 1)'))), []);
  // The same uses in another order are no change; what is left over pairs up.
  assert.deepEqual(ids(diff(withField('x: Int @tag(name: "a") @tag(name: "b")'), withField('x: Int @tag(name: "b") @tag(name: "a")'))), []);
  const moved = diff(withField('x: Int @tag(name: "a") @tag(name: "b")'), withField('x: Int @tag(name: "b") @tag(name: "c")'));
  assert.deepEqual(moved.changes.map((c) => c.message), ['`@tag(name: "a")` on field `Query.x` is now `@tag(name: "c")`']);
  // The built-in ones are their own rules, never "usage".
  assert.deepEqual(ids(diff(withField('x: Int'), withField('x: Int @deprecated'))), ['info:field-deprecated']);
});

test('federation: subgraph SDL compares without its directive definitions, orphan extensions and all', () => {
  const v1 = `
    extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable", "@external", "@requires", "@provides"])
    type Query { product(id: ID!): Product }
    type Product @key(fields: "id") @key(fields: "sku") { id: ID! sku: String! name: String @shareable reviews: [Review!]! @provides(fields: "stars") }
    extend type Review @key(fields: "id") { id: ID! @external stars: Int @external product: Product @requires(fields: "stars") }
  `;
  const v2 = `
    extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", "@shareable", "@external", "@requires", "@provides"])
    type Query { product(id: ID!): Product }
    type Product @key(fields: "id") { id: ID! sku: String! name: String @shareable reviews: [Review!]! }
    extend type Review @key(fields: "id") { id: ID! @external stars: Int @external product: Product @requires(fields: "stars") }
  `;
  const r = diff(v1, v2);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(ids(r).sort(), ['info:directive-usage-removed', 'info:directive-usage-removed']);
  assert.deepEqual(
    r.changes.map((c) => c.message).sort(),
    ['`@key(fields: "sku")` removed from object type `Product`', '`@provides(fields: "stars")` removed from field `Product.reviews`'],
  );
  // The orphan extension is a type like any other: dropping a field from it is a removal.
  const r2 = diff(v2, v2.replace(' product: Product @requires(fields: "stars")', ''));
  assert.deepEqual(ids(r2), ['error:field-removed']);
  assert.equal(r2.changes[0].message, 'Field `Review.product` removed');
  // Federation v1 style, `@extends` and `_FieldSet` and all, is the same.
  const f1 = 'type Query { x: Int }\ntype User @key(fields: "id") @extends { id: ID! @external name: String }\nscalar _FieldSet\ndirective @key(fields: _FieldSet!) repeatable on OBJECT | INTERFACE';
  assert.deepEqual(ids(diff(f1, f1.replace(' name: String', ''))), ['error:field-removed']);
});

// --- coverage ----------------------------------------------------------------------------

test('every rule in the catalog is produced by some test above', () => {
  assert.deepEqual(
    core
      .allRules()
      .map((r) => r.id)
      .filter((id) => !produced.has(id)),
    [],
  );
});

test('every change has the level the catalog gives its id', () => {
  const known = new Map(core.allRules().map((r) => [r.id, r]));
  const read = (f) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
  const r = diff(read('bookshop-v1.graphql'), read('bookshop-v2.graphql'));
  for (const c of [...r.changes, ...levelChecks]) {
    const rule = known.get(c.id);
    assert.ok(rule, `${c.id} is in the catalog`);
    if (typeof rule.level === 'string') assert.equal(c.level, rule.level, `${c.id}: ${c.message}`);
  }
});

test('every rule produced is in the catalog', () => {
  const known = new Set(core.allRules().map((r) => r.id));
  assert.deepEqual([...produced].filter((id) => !known.has(id)), []);
});
