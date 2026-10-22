export { compareSchemas, diffSchemas, type Change } from './diff';
export { decodeText } from './text';
export { looksLikeSchema, looksLikeIntrospection, type SchemaKind } from './detect';
export { globMatcher, isSafeGlob } from './glob';
export { codeSpan, mdText } from './md';
export { groupLabel, groupTitle, compareGroups, toMarkdown, toReleaseNotes, releaseSection, type ReleaseNotesInfo } from './markdown';
export { loadSchema, typeStr, valueStr, litOf, hasTypeSystem, MAX_FILES, KIND_WORD, type Capability, type Lit, type Schema, type Side, type TypeDef, type Field, type InputValue } from './model';
export { applyPolicy, count, readIgnore, matches, nameMatcher, escapeName, atLeast, type Counts, type IgnoreRule, type NameMatcher, type Policy } from './policy';
export { allRules, ruleLevel, INPUT_RULES, INPUT_PREFIXES, inputId, type Rule, type RuleLevel } from './rules';
export { parseTypeRef, compareTypeRefs, namedType, type TypeRef, type TypeChange } from './typeref';
export { LEVEL_ORDER, KIND_NAME, type Level, type Loc, type LoadError, type Kind, type TypeKind } from './types';
export { guessOrder, compareVersions, versionParts, type Candidate } from './order';

import { diffSchemas, type Change } from './diff';
import { loadSchema, type Schema, type Side } from './model';
import type { SchemaKind } from './detect';
import type { LoadError } from './types';

export interface SideInfo {
  kind: SchemaKind;
  /** Types the side defines (built-in scalars not counted). */
  types: number;
}

export interface Result {
  changes: Change[];
  /** Per side: why it couldn't be read. Both undefined when the comparison ran. */
  errors: { old?: LoadError; new?: LoadError };
  /** Files left out, definitions seen twice: the comparison ran, but take note. */
  warnings: string[];
  /** The files each side was read from: the main one and the others of a split schema. */
  files: { old: string[]; new: string[] };
  info: { old?: SideInfo; new?: SideInfo };
  ms: number;
}

/** Loads both sides and compares them. Never throws for bad input: errors come back in the result. */
export function compare(oldSide: Side, newSide: Side): Result {
  const t = Date.now();
  const a = cachedLoad(oldSide);
  const b = cachedLoad(newSide);
  const info = { old: infoOf(a.schema), new: infoOf(b.schema) };
  const files = { old: a.schema?.files ?? [oldSide.path], new: b.schema?.files ?? [newSide.path] };
  if (!a.schema || !b.schema) return { changes: [], errors: { old: a.error, new: b.error }, warnings: [], files, info, ms: Date.now() - t };
  const { changes, warnings: skipped } = diffSchemas(a.schema, b.schema);
  const warnings = [...new Set([...a.schema.warnings.map((w) => `Old: ${w}`), ...b.schema.warnings.map((w) => `New: ${w}`), ...skipped])];
  return { changes, errors: {}, warnings, files, info, ms: Date.now() - t };
}

const infoOf = (s?: Schema): SideInfo | undefined => (s ? { kind: s.kind, types: s.types.size } : undefined);

/**
 * The last few loaded sides, by their texts: comparing again after an edit to one side
 * doesn't parse the other again.
 */
const cache: Array<{ key: string; size: number; loaded: { schema?: Schema; error?: LoadError } }> = [];
/** Characters of schema text the cache may hold (a loaded schema takes several times that). */
const CACHE_CHARS = 24_000_000;

function cacheKey(side: Side): string {
  // Texts are kept in the key: no hashing, and no false hits.
  return [side.path, side.text, ...(side.files ?? []).map((f) => `\0${f.path}\0${f.text}`), ...(side.warnings ?? []).map((w) => `\x01${w}`)].join('\0');
}

function cachedLoad(side: Side): { schema?: Schema; error?: LoadError } {
  const key = cacheKey(side);
  const hit = cache.find((c) => c.key === key);
  if (hit) return hit.loaded;
  const loaded = loadSchema(side);
  if (key.length <= CACHE_CHARS / 2) {
    cache.unshift({ key, size: key.length, loaded });
    let total = 0;
    const keep = cache.findIndex((c, i) => (total += c.size) > CACHE_CHARS || i >= 4);
    if (keep >= 0) cache.length = keep;
  }
  return loaded;
}

/** Lets go of the loaded schemas kept for the next comparison. */
export function clearCache() {
  cache.length = 0;
}
