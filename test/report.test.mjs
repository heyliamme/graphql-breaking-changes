// Ignore rules, warnings as errors, the Markdown changelog, release notes, the view's
// grouping, which file is the old one, and the README's list of changes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { core, diff, ids } from './helpers.mjs';

const model = createRequire(import.meta.url)('../dist/model.js');

const change = (id, level, kind, type, field, message = 'm') => ({ id, level, kind, type, field, message });

test('readIgnore keeps only sensible entries', () => {
  assert.deepEqual(core.readIgnore(['a-b', ' ', 3, null, { id: 'x', extra: 1 }, { reason: 'only a reason' }, { type: 'User', field: 'email', reason: 'legacy' }, 'c']), [
    { id: 'a-b' },
    { id: 'x' },
    { type: 'User', field: 'email', reason: 'legacy' },
    { id: 'c' },
  ]);
  assert.deepEqual(core.readIgnore('nope'), []);
});

test('name patterns: * matches any run, \\* a star', () => {
  assert.ok(core.nameMatcher('*-description-changed').test('field-description-changed'));
  assert.ok(core.nameMatcher('Internal*').test('InternalUser'));
  assert.ok(!core.nameMatcher('Internal*').test('User'));
  assert.ok(!core.nameMatcher('a.b').test('axb'));
  assert.ok(core.nameMatcher(core.escapeName('a*b')).test('a*b'));
  assert.ok(!core.nameMatcher(core.escapeName('a*b')).test('axb'));
  assert.ok(core.nameMatcher('@key').test('@key'));
});

test('applyPolicy marks ignored changes by id, type and field, and can promote warnings', () => {
  const cs = [
    change('field-removed', 'error', 'OBJECT', 'User', 'email'),
    change('enum-value-added', 'warning', 'ENUM', 'Status', 'ARCHIVED'),
    change('type-added', 'info', 'OBJECT', 'InternalLog'),
    change('field-description-changed', 'info', 'OBJECT', 'User', 'name'),
    change('directive-removed', 'error', 'DIRECTIVE', '@key'),
    change('schema-description-changed', 'info', 'SCHEMA'),
  ];
  const p = core.applyPolicy(cs, { ignore: core.readIgnore(['*-description-changed', { type: 'Internal*', reason: 'not public' }, { type: 'User', field: 'email' }, { id: 'directive-*', type: '@key' }]), warningsAsErrors: true });
  assert.deepEqual(
    p.map((c) => [c.level, c.ignored]),
    [
      ['error', ''],
      ['error', undefined],
      ['info', 'not public'],
      ['info', ''],
      ['error', ''],
      ['info', ''],
    ],
  );
  assert.deepEqual(core.count(p), { error: 1, warning: 0, info: 0, ignored: 5 });
  // The input is left alone.
  assert.equal(cs[1].level, 'warning');
  assert.equal(cs[0].ignored, undefined);
  // A field rule never matches a change with no field; a type rule never matches the schema.
  assert.deepEqual(
    core.applyPolicy(cs, { ignore: [{ field: 'email' }], warningsAsErrors: false }).map((c) => c.ignored),
    ['', undefined, undefined, undefined, undefined, undefined],
  );
});

test('Markdown: headings by level, grouped by type, ignored left out, names escaped', () => {
  const cs = [
    change('field-removed', 'error', 'OBJECT', 'User', 'email', 'Field `User.email` removed'),
    change('field-became-nullable', 'error', 'OBJECT', 'User', 'name', 'Field `User.name` can now be `null`: `String!` → `String`'),
    change('enum-value-added', 'warning', 'ENUM', 'Status', 'ARCHIVED', 'Enum value `Status.ARCHIVED` added'),
    change('directive-removed', 'error', 'DIRECTIVE', '@key', undefined, 'Directive `@key` removed'),
    change('schema-description-changed', 'info', 'SCHEMA', undefined, undefined, 'Description of the schema changed'),
    change('type-added', 'info', 'OBJECT', 'Post', undefined, 'Object type `Post` added'),
    { ...change('field-added', 'info', 'OBJECT', 'Hidden', 'x', 'Field `Hidden.x` added'), ignored: '' },
  ];
  const md = core.toMarkdown(cs, 'Schema changes: a → b');
  assert.equal(
    md,
    [
      '### Schema changes: a → b',
      '',
      '**3 breaking** · 1 dangerous · 2 other · 1 ignored',
      '',
      '#### Breaking changes',
      '',
      '- `type User`',
      '  - Field `User.email` removed',
      '  - Field `User.name` can now be `null`: `String!` → `String`',
      '- `directive @key`: Directive `@key` removed',
      '',
      '#### Dangerous changes',
      '',
      '- `enum Status`: Enum value `Status.ARCHIVED` added',
      '',
      '#### Other changes',
      '',
      '- `schema`: Description of the schema changed',
      '- `type Post`: Object type `Post` added',
      '',
    ].join('\n'),
  );
  assert.equal(core.toMarkdown([], 'x'), '### x\n\n**0 breaking** · 0 dangerous · 0 other\n\nNo changes for API clients.\n');
  // A title with a newline stays one heading.
  assert.ok(core.toMarkdown([], 'a\nb').startsWith('### a b\n'));
});

test('release notes: Breaking, Dangerous, Added, Changed, with a summary line', () => {
  const cs = [
    change('field-removed', 'error', 'OBJECT', 'User', 'email', 'Field `User.email` removed'),
    change('enum-value-added', 'warning', 'ENUM', 'Status', 'ARCHIVED', 'Enum value `Status.ARCHIVED` added'),
    change('field-added', 'info', 'OBJECT', 'User', 'phone', 'Field `User.phone` added'),
    change('type-added', 'info', 'OBJECT', 'Post', undefined, 'Object type `Post` added'),
    change('field-deprecated', 'info', 'OBJECT', 'User', 'name', 'Field `User.name` deprecated'),
    { ...change('field-added', 'info', 'OBJECT', 'Hidden', 'x', 'Field `Hidden.x` added'), ignored: '' },
  ];
  const md = core.toReleaseNotes(cs, { from: '`v1.0.0`', to: '`v2.0.0`', schema: 'schema.graphql' });
  assert.equal(
    md,
    [
      '## Schema changes in `v2.0.0`',
      '',
      'Changes since `v1.0.0`, in `schema.graphql`. 1 breaking change, 1 dangerous change, 2 additions, 1 other change.',
      '',
      '### Breaking changes',
      '',
      '- `type User`: Field `User.email` removed',
      '',
      '### Dangerous changes',
      '',
      '- `enum Status`: Enum value `Status.ARCHIVED` added _(may break some clients)_',
      '',
      '### Added',
      '',
      '- `type Post`: Object type `Post` added',
      '- `type User`: Field `User.phone` added',
      '',
      '### Changed',
      '',
      '- `type User`: Field `User.name` deprecated',
      '',
    ].join('\n'),
  );
  assert.equal(core.toReleaseNotes([], { from: 'a', to: 'the working copy' }), '## Schema changes in the working copy\n\nChanges since a.\n\nNo changes for API clients.\n');
  assert.deepEqual(['field-removed', 'enum-value-added', 'type-added', 'field-deprecated', 'directive-usage-added'].map((id) => core.releaseSection({ id, level: id === 'field-removed' ? 'error' : id === 'enum-value-added' ? 'warning' : 'info' })), ['breaking', 'dangerous', 'added', 'changed', 'added']);
});

test('Markdown that schema content cannot break out of', () => {
  const r = diff('type Query { x: Int }\nenum E { A }', 'type Query { x: Int }\nenum E { A }\ntype `A { a: Int }'.replace('`', ''));
  assert.deepEqual(ids(r), ['info:type-added']);
  assert.equal(core.codeSpan('a`b'), '`` a`b ``');
  assert.equal(core.codeSpan('a\nb'), '`a b`');
  assert.equal(core.mdText('[x](y) <b> @me'), '\\[x\\](y) \\<b\\> @​me');
});

test('view: groups by type, the schema first and directives last, breaking first inside', () => {
  const cs = [
    change('field-added', 'info', 'OBJECT', 'User', 'phone'),
    change('type-added', 'info', 'OBJECT', 'Post'),
    change('directive-removed', 'error', 'DIRECTIVE', '@key'),
    change('field-removed', 'error', 'OBJECT', 'User', 'email'),
    change('schema-root-changed', 'error', 'SCHEMA'),
    change('enum-value-removed', 'error', 'ENUM', 'Status', 'OLD'),
    change('field-became-nullable', 'error', 'OBJECT', 'User', 'age'),
  ];
  const g = model.groupChanges(cs);
  assert.deepEqual(
    g.map((x) => x.key),
    ['schema', 'type Post', 'enum Status', 'type User', 'directive @key'],
  );
  assert.deepEqual(g.find((x) => x.key === 'type User').items, [6, 3, 0]);
  assert.equal(model.groupKey(change('x', 'info', 'INPUT_OBJECT', 'In')), 'input In');
});

test('view: the filter matches type, field, kind, id and message', () => {
  const c = change('field-removed', 'error', 'OBJECT', 'User', 'email', 'Field `User.email` removed');
  assert.ok(model.matchesQuery(c, 'user email'));
  assert.ok(model.matchesQuery(c, 'FIELD-REMOVED'));
  assert.ok(model.matchesQuery(c, 'type user'));
  assert.ok(!model.matchesQuery(c, 'enum'));
  assert.ok(model.matchesQuery(change('schema-root-changed', 'error', 'SCHEMA'), 'schema'));
  assert.equal(model.messageHtml('value `` a`b `` removed'), 'value <code>a`b</code> removed');
  assert.equal(model.messageHtml('<b>`a`'), '&lt;b&gt;<code>a</code>');
});

test('a full comparison of the sample schemas', () => {
  const read = (f) => readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
  const r = diff(read('bookshop-v1.graphql'), read('bookshop-v2.graphql'));
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.warnings, []);
  const n = core.count(r.changes);
  assert.deepEqual(n, { error: 12, warning: 8, info: 19, ignored: 0 });
  assert.ok(ids(r).includes('error:field-removed'));
  assert.ok(r.ms < 500, `${r.ms} ms`);
  // The same schema twice: nothing.
  assert.deepEqual(ids(diff(read('bookshop-v2.graphql'), read('bookshop-v2.graphql'))), []);
});

test('the README lists every change id with its level', async () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  // The tables are generated from the catalog: levels and summaries, not only the ids.
  const { tables } = await import('../scripts/rules-table.mjs');
  assert.ok(readme.includes(tables()), 'README tables differ from `node scripts/rules-table.mjs`');
  const missing = core.allRules().filter((r) => !readme.includes(`\`${r.id}\``));
  assert.deepEqual(
    missing.map((r) => r.id),
    [],
  );
  // The settings table and the commands table name every setting and command.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const k of Object.keys(pkg.contributes.configuration.properties)) assert.ok(readme.includes(`\`${k}\``), k);
  for (const c of pkg.contributes.commands) if (c.command !== 'graphqlBreakingChanges.compareSelected') assert.ok(readme.includes(c.title), c.title);
});

test('two files: which is the old one, from the names; nothing said, no guess', () => {
  const order = (a, b) => core.guessOrder({ name: a }, { name: b })?.old;
  assert.equal(order('schema.graphql', 'schema-v2.graphql'), 0);
  assert.equal(order('schema-v2.graphql', 'schema.graphql'), 1);
  assert.equal(order('api-new.graphql', 'api-old.graphql'), 1);
  assert.equal(order('after.gql', 'before.gql'), 1);
  assert.equal(order('schema-v10.graphql', 'schema-v9.graphql'), 1);
  assert.equal(order('schema.2024-05-01.json', 'schema.2023-12-01.json'), 1);
  assert.equal(order('schema.graphql', 'schema.json'), undefined);
  assert.equal(order('left.graphql', 'right.graphql'), undefined);
});

test('name patterns take linear time on long names', () => {
  const long = '_'.repeat(50_000);
  const t = Date.now();
  for (let i = 0; i < 100; i++) {
    assert.ok(!core.nameMatcher('*_*Input').test(long));
    assert.ok(!core.nameMatcher('*_*_*Input').test(long));
  }
  assert.ok(Date.now() - t < 500, `${Date.now() - t} ms`);
  assert.ok(core.nameMatcher('*_*Input').test('Create_UserInput'));
  assert.ok(core.nameMatcher('a*b*c').test('abc'));
  assert.ok(core.nameMatcher('a*b*c').test('aXbYbc'));
  assert.ok(!core.nameMatcher('a*b*c').test('acb'));
  assert.ok(!core.nameMatcher('ab*ba').test('aba'), 'prefix and suffix may not overlap');
  assert.ok(core.nameMatcher('*').test(''));
  assert.ok(core.nameMatcher('**x').test('x'));
});
