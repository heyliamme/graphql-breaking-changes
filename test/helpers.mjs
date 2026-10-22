import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const core = createRequire(import.meta.url)('../dist/core.js');

/** Every id any test produced, to check that every documented rule is exercised. */
export const produced = new Set();
/** Every change any test produced, to check levels against the catalog. */
export const levelChecks = [];

const OLD = '/api/old/schema.graphql';
const NEW = '/api/new/schema.graphql';

/**
 * Compares two schemas given as SDL text (or introspection JSON text). `files` are the
 * other files of a split schema, by path relative to the schema's folder, for both sides
 * unless `oldFiles` / `newFiles` say otherwise.
 */
export function diff(a, b, { files, oldFiles, newFiles } = {}) {
  const toFiles = (dir, f) => (f ? Object.entries(f).map(([p, text]) => ({ path: `${dir}/${p}`, text })) : undefined);
  const r = core.compare({ text: a, path: OLD, files: toFiles('/api/old', oldFiles ?? files) }, { text: b, path: NEW, files: toFiles('/api/new', newFiles ?? files) });
  for (const c of r.changes) {
    produced.add(c.id);
    levelChecks.push(c);
  }
  return r;
}

export const ids = (r) => r.changes.map((c) => `${c.level}:${c.id}`);
export const only = (r, id) => r.changes.filter((c) => c.id === id);

/** Asserts the ids of a → b and of b → a. */
export function pair(a, b, forward, backward, what = '') {
  assert.deepEqual(ids(diff(a, b)).sort(), [...forward].sort(), `forward ${what}`);
  assert.deepEqual(ids(diff(b, a)).sort(), [...backward].sort(), `backward ${what}`);
}

/** A schema with `Query.x` of the given field definition (`x: Int!`, `x(a: Int): Int`). */
export const withField = (field, extra = '') => `type Query { ${field} }\n${extra}`;

/** A schema with an input type `I` holding `fields`, taken by `Query.x`. */
export const withInput = (fields, extra = '') => `type Query { x(i: I): Int }\ninput I { ${fields} }\n${extra}`;

/** A schema with a directive `@d` taking `args`. */
export const withDirective = (args, extra = '') => `type Query { x: Int }\ndirective @d${args ? `(${args})` : ''} on FIELD_DEFINITION\n${extra}`;
