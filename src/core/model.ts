/**
 * The schema as the comparison sees it, built from SDL (one file or several, with their
 * extensions) or from an introspection result. Built from the AST, not a validated
 * GraphQLSchema: a type that is referenced but not defined, a federation directive with no
 * definition, or an `extend type` with nothing to extend is kept as written, so partial
 * and subgraph schemas compare too.
 */
import { buildClientSchema, GraphQLError, Kind, parse, printSchema, Source, type ASTNode, type DefinitionNode, type DirectiveNode, type DocumentNode, type EnumValueDefinitionNode, type FieldDefinitionNode, type InputValueDefinitionNode, type TypeNode, type ValueNode } from 'graphql';
import { looksLikeSchema, type SchemaKind } from './detect';
import { jsonLocator, type Locator } from './jsonloc';
import type { LoadError, TypeKind } from './types';

export interface Pos {
  file: string;
  line: number;
  col: number;
}

export interface Directive {
  name: string;
  /** Argument values as normalised SDL text, by name. */
  args: Map<string, string>;
  pos?: Pos;
}

/** `@deprecated`; `reason` is undefined for the default ("No longer supported"). */
export interface Deprecation {
  reason?: string;
}

/**
 * A value as written, for comparing defaults by what they mean: numbers kept apart from
 * other leaves (`2.0` and `2` are the same Float), lists and input objects as their parts.
 * Other leaves are SDL text. No AST nodes: they would keep the whole document alive.
 */
export type Lit = string | { num: string } | Lit[] | { obj: Array<[string, Lit]> };

export interface InputValue {
  name: string;
  type: string;
  /** The default value as normalised SDL text. */
  default?: string;
  defaultLit?: Lit;
  description?: string;
  deprecated?: Deprecation;
  directives: Directive[];
  pos?: Pos;
}

export interface Field {
  name: string;
  type: string;
  args: Map<string, InputValue>;
  description?: string;
  deprecated?: Deprecation;
  directives: Directive[];
  pos?: Pos;
}

export interface EnumValue {
  name: string;
  description?: string;
  deprecated?: Deprecation;
  directives: Directive[];
  pos?: Pos;
}

export interface TypeDef {
  name: string;
  kind: TypeKind;
  description?: string;
  directives: Directive[];
  pos?: Pos;
  /** Object and interface types. */
  fields: Map<string, Field>;
  interfaces: string[];
  /** Input objects. */
  inputFields: Map<string, InputValue>;
  oneOf: boolean;
  /** Enums. */
  values: Map<string, EnumValue>;
  /** Unions. */
  members: string[];
  /** Scalars: the `@specifiedBy` URL. */
  specifiedBy?: string;
  /** Only `extend type X` was seen (a federation subgraph extending another's type). */
  extensionOnly: boolean;
}

export interface DirectiveDef {
  name: string;
  description?: string;
  args: Map<string, InputValue>;
  locations: string[];
  repeatable: boolean;
  pos?: Pos;
}

export type RootOp = 'query' | 'mutation' | 'subscription';
export const ROOT_OPS: RootOp[] = ['query', 'mutation', 'subscription'];

/**
 * What an introspection result may leave out: graphql-js's `getIntrospectionQuery()` asks
 * for none of these by default, and most `schema.json` files are made with it.
 */
export type Capability = 'oneOf' | 'repeatable' | 'inputDeprecation' | 'specifiedBy';

export interface Schema {
  kind: SchemaKind;
  description?: string;
  /** Root types: those a `schema { }` block names, else the default names when such types exist. */
  roots: Partial<Record<RootOp, string>>;
  explicitRoots: boolean;
  schemaPos?: Pos;
  schemaDirectives: Directive[];
  types: Map<string, TypeDef>;
  directives: Map<string, DirectiveDef>;
  /** The files it was read from, the main one first. */
  files: string[];
  warnings: string[];
  /** For an introspection result: what it doesn't say, so can't be compared. */
  lacks: Set<Capability>;
}

export const DEFAULT_ROOTS: Record<RootOp, string> = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' };

export const MAX_FILES = 2000;

/** One side of a comparison, as the extension hands it in. */
export interface Side {
  text: string;
  /** POSIX path of the main file. */
  path: string;
  /** Other SDL files of a split schema, already read (at the same version). */
  files?: Array<{ path: string; text: string }>;
  /** What reading the files left out, said with the comparison's warnings. */
  warnings?: string[];
}

// --- building from the AST ----------------------------------------------------------------

const pos = (node: ASTNode | undefined, file: string): Pos | undefined => {
  const t = node?.loc?.startToken;
  return t ? { file, line: t.line - 1, col: t.column - 1 } : undefined;
};

export function typeStr(t: TypeNode): string {
  if (t.kind === Kind.NAMED_TYPE) return t.name.value;
  if (t.kind === Kind.LIST_TYPE) return `[${typeStr(t.type)}]`;
  return `${typeStr(t.type)}!`;
}

/** A value as SDL text, with object fields sorted so that key order isn't a change. */
export function valueStr(v: ValueNode): string {
  switch (v.kind) {
    case Kind.INT:
    case Kind.FLOAT:
    case Kind.ENUM:
      return v.value;
    case Kind.STRING:
      return JSON.stringify(v.value);
    case Kind.BOOLEAN:
      return v.value ? 'true' : 'false';
    case Kind.NULL:
      return 'null';
    case Kind.VARIABLE:
      return `$${v.name.value}`;
    case Kind.LIST:
      return `[${v.values.map(valueStr).join(', ')}]`;
    case Kind.OBJECT:
      return `{${[...v.fields]
        .sort((a, b) => a.name.value.localeCompare(b.name.value))
        .map((f) => `${f.name.value}: ${valueStr(f.value)}`)
        .join(', ')}}`;
  }
}

/** A value as a `Lit`, object fields sorted. */
export function litOf(v: ValueNode): Lit {
  switch (v.kind) {
    case Kind.INT:
    case Kind.FLOAT:
      return { num: v.value };
    case Kind.LIST:
      return v.values.map(litOf);
    case Kind.OBJECT:
      return { obj: [...v.fields].sort((a, b) => a.name.value.localeCompare(b.name.value)).map((f) => [f.name.value, litOf(f.value)] as [string, Lit]) };
    default:
      return valueStr(v);
  }
}

const DEFAULT_DEPRECATION = 'No longer supported';

interface Annotated {
  directives: Directive[];
  deprecated?: Deprecation;
  specifiedBy?: string;
  oneOf: boolean;
}

/** The directives on a node: `@deprecated`, `@specifiedBy` and `@oneOf` taken out, the rest kept. */
function directivesOf(nodes: readonly DirectiveNode[] | undefined, file: string): Annotated {
  const out: Annotated = { directives: [], oneOf: false };
  for (const d of nodes ?? []) {
    const name = d.name.value;
    const args = new Map<string, string>();
    for (const a of d.arguments ?? []) args.set(a.name.value, valueStr(a.value));
    if (name === 'deprecated') {
      const r = d.arguments?.find((a) => a.name.value === 'reason')?.value;
      const reason = r?.kind === Kind.STRING ? r.value : r ? valueStr(r) : undefined;
      out.deprecated = { reason: reason === undefined || reason === DEFAULT_DEPRECATION ? undefined : reason };
    } else if (name === 'specifiedBy') {
      const u = d.arguments?.find((a) => a.name.value === 'url')?.value;
      out.specifiedBy = u?.kind === Kind.STRING ? u.value : u ? valueStr(u) : '';
    } else if (name === 'oneOf') out.oneOf = true;
    else out.directives.push({ name, args, pos: pos(d, file) });
  }
  return out;
}

function inputValue(n: InputValueDefinitionNode, file: string): InputValue {
  const a = directivesOf(n.directives, file);
  return {
    name: n.name.value,
    type: typeStr(n.type),
    default: n.defaultValue ? valueStr(n.defaultValue) : undefined,
    defaultLit: n.defaultValue ? litOf(n.defaultValue) : undefined,
    description: n.description?.value,
    deprecated: a.deprecated,
    directives: a.directives,
    pos: pos(n.name, file),
  };
}

function field(n: FieldDefinitionNode, file: string): Field {
  const a = directivesOf(n.directives, file);
  const args = new Map<string, InputValue>();
  for (const x of n.arguments ?? []) args.set(x.name.value, inputValue(x, file));
  return { name: n.name.value, type: typeStr(n.type), args, description: n.description?.value, deprecated: a.deprecated, directives: a.directives, pos: pos(n.name, file) };
}

function enumValue(n: EnumValueDefinitionNode, file: string): EnumValue {
  const a = directivesOf(n.directives, file);
  return { name: n.name.value, description: n.description?.value, deprecated: a.deprecated, directives: a.directives, pos: pos(n.name, file) };
}

const KIND_OF: Partial<Record<string, TypeKind>> = {
  [Kind.SCALAR_TYPE_DEFINITION]: 'SCALAR',
  [Kind.SCALAR_TYPE_EXTENSION]: 'SCALAR',
  [Kind.OBJECT_TYPE_DEFINITION]: 'OBJECT',
  [Kind.OBJECT_TYPE_EXTENSION]: 'OBJECT',
  [Kind.INTERFACE_TYPE_DEFINITION]: 'INTERFACE',
  [Kind.INTERFACE_TYPE_EXTENSION]: 'INTERFACE',
  [Kind.UNION_TYPE_DEFINITION]: 'UNION',
  [Kind.UNION_TYPE_EXTENSION]: 'UNION',
  [Kind.ENUM_TYPE_DEFINITION]: 'ENUM',
  [Kind.ENUM_TYPE_EXTENSION]: 'ENUM',
  [Kind.INPUT_OBJECT_TYPE_DEFINITION]: 'INPUT_OBJECT',
  [Kind.INPUT_OBJECT_TYPE_EXTENSION]: 'INPUT_OBJECT',
};

const EXTENSIONS = new Set<string>([Kind.SCALAR_TYPE_EXTENSION, Kind.OBJECT_TYPE_EXTENSION, Kind.INTERFACE_TYPE_EXTENSION, Kind.UNION_TYPE_EXTENSION, Kind.ENUM_TYPE_EXTENSION, Kind.INPUT_OBJECT_TYPE_EXTENSION]);

export const KIND_WORD: Record<TypeKind, string> = { SCALAR: 'scalar', OBJECT: 'object type', INTERFACE: 'interface', UNION: 'union', ENUM: 'enum', INPUT_OBJECT: 'input type' };

/**
 * Built into every schema, so left out as graphql-js's printSchema leaves them out: some
 * printers (graphql-java's) write them, introspection and most others don't.
 */
const SPECIFIED_SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);
const SPECIFIED_DIRECTIVES = new Set(['skip', 'include', 'deprecated', 'specifiedBy', 'oneOf']);

const where = (p?: Pos) => (p ? `${p.file.split('/').pop()}:${p.line + 1}` : 'an unknown place');

export function hasTypeSystem(doc: DocumentNode): boolean {
  return doc.definitions.some((d) => d.kind in KIND_OF || d.kind === Kind.SCHEMA_DEFINITION || d.kind === Kind.SCHEMA_EXTENSION || d.kind === Kind.DIRECTIVE_DEFINITION);
}

export function emptySchema(kind: SchemaKind): Schema {
  return { kind, roots: {}, explicitRoots: false, schemaDirectives: [], types: new Map(), directives: new Map(), files: [], warnings: [], lacks: new Set() };
}

class Builder {
  schema = emptySchema('sdl');

  add(doc: DocumentNode, file: string) {
    this.schema.files.push(file);
    for (const d of doc.definitions) this.definition(d, file);
  }

  /**
   * Without a `schema { }` block, the root types are `Query`, `Mutation` and
   * `Subscription` when they exist. With one, only what it names (as graphql-js reads it).
   */
  finish(): Schema {
    const s = this.schema;
    if (s.explicitRoots) return s;
    for (const op of ROOT_OPS) {
      if (s.roots[op]) continue;
      const t = s.types.get(DEFAULT_ROOTS[op]);
      if (t && t.kind === 'OBJECT') s.roots[op] = t.name;
    }
    return s;
  }

  private definition(d: DefinitionNode, file: string) {
    const s = this.schema;
    if (d.kind === Kind.SCHEMA_DEFINITION || d.kind === Kind.SCHEMA_EXTENSION) {
      if (d.kind === Kind.SCHEMA_DEFINITION) {
        if (s.explicitRoots) s.warnings.push(`The schema block is defined again at ${where(pos(d, file))}; the first one is used.`);
        s.description ??= d.description?.value;
        s.schemaPos ??= pos(d, file);
        // An `extend schema` (federation's @link) alone leaves the default root names in place.
        s.explicitRoots = true;
      }
      for (const o of d.operationTypes ?? []) s.roots[o.operation as RootOp] ??= o.type.name.value;
      s.schemaDirectives.push(...directivesOf(d.directives, file).directives);
      return;
    }
    if (d.kind === Kind.DIRECTIVE_DEFINITION) {
      const name = d.name.value;
      if (SPECIFIED_DIRECTIVES.has(name)) return;
      if (s.directives.has(name)) {
        s.warnings.push(`Directive \`@${name}\` is defined again at ${where(pos(d.name, file))}; the first definition is used.`);
        return;
      }
      const args = new Map<string, InputValue>();
      for (const x of d.arguments ?? []) args.set(x.name.value, inputValue(x, file));
      s.directives.set(name, { name, description: d.description?.value, args, locations: d.locations.map((l) => l.value), repeatable: d.repeatable, pos: pos(d.name, file) });
      return;
    }
    const kind = KIND_OF[d.kind];
    if (!kind) return; // queries, fragments
    const node = d as Extract<DefinitionNode, { name: { value: string } }>;
    const name = node.name.value;
    if (kind === 'SCALAR' && SPECIFIED_SCALARS.has(name)) return;
    const ext = EXTENSIONS.has(d.kind);
    let t = s.types.get(name);
    if (t && !ext && !t.extensionOnly) {
      s.warnings.push(`${cap(KIND_WORD[kind])} \`${name}\` is defined again at ${where(pos(node.name, file))}; the first definition is used.`);
      return;
    }
    if (t && t.kind !== kind) {
      s.warnings.push(`\`${name}\` is ${article(KIND_WORD[t.kind])}, but ${where(pos(node.name, file))} ${ext ? 'extends' : 'defines'} it as ${article(KIND_WORD[kind])}; that part is left out.`);
      return;
    }
    if (!t) {
      t = { name, kind, directives: [], fields: new Map(), interfaces: [], inputFields: new Map(), oneOf: false, values: new Map(), members: [], extensionOnly: ext };
      s.types.set(name, t);
    }
    if (!ext) {
      // The definition's own position and description win over an extension seen first.
      t.extensionOnly = false;
      t.pos = pos(node.name, file);
      if ('description' in node && node.description) t.description = node.description.value;
    } else t.pos ??= pos(node.name, file);
    const a = directivesOf(node.directives, file);
    t.directives.push(...a.directives);
    if (a.specifiedBy !== undefined) t.specifiedBy = a.specifiedBy;
    if (a.oneOf) t.oneOf = true;
    if ('interfaces' in node) for (const i of node.interfaces ?? []) if (!t.interfaces.includes(i.name.value)) t.interfaces.push(i.name.value);
    if ('fields' in node && node.fields) {
      for (const f of node.fields) {
        if (f.kind === Kind.FIELD_DEFINITION) {
          if (!t.fields.has(f.name.value)) t.fields.set(f.name.value, field(f, file));
          else s.warnings.push(`Field \`${name}.${f.name.value}\` is defined again at ${where(pos(f.name, file))}; the first definition is used.`);
        } else if (!t.inputFields.has(f.name.value)) t.inputFields.set(f.name.value, inputValue(f, file));
        else s.warnings.push(`Input field \`${name}.${f.name.value}\` is defined again at ${where(pos(f.name, file))}; the first definition is used.`);
      }
    }
    if ('values' in node) for (const v of node.values ?? []) if (!t.values.has(v.name.value)) t.values.set(v.name.value, enumValue(v, file));
    if ('types' in node) for (const m of node.types ?? []) if (!t.members.includes(m.name.value)) t.members.push(m.name.value);
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const article = (s: string) => (/^[aeiou]/.test(s) ? `an ${s}` : `a ${s}`);

function parseSdl(text: string, path: string): { doc?: DocumentNode; error?: LoadError } {
  try {
    return { doc: parse(new Source(text, path)) };
  } catch (e) {
    if (e instanceof GraphQLError) {
      const l = e.locations?.[0];
      return { error: { message: e.message.replace(/^Syntax Error: /, ''), file: path, line: l ? l.line - 1 : undefined, col: l ? l.column - 1 : undefined } };
    }
    return { error: { message: e instanceof Error ? e.message : String(e), file: path } };
  }
}

// --- introspection -------------------------------------------------------------------------

/** The `__schema` object in an introspection result, wrapped in `data` or not. */
function introspectionOf(text: string): { schema?: unknown; error?: string } {
  let v: unknown;
  try {
    v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return { error: `is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  const o = v as Record<string, unknown> | null;
  if (o && typeof o === 'object') {
    if (o.__schema && typeof o.__schema === 'object') return { schema: o.__schema };
    const data = o.data as Record<string, unknown> | undefined;
    if (data && typeof data === 'object' && data.__schema && typeof data.__schema === 'object') return { schema: data.__schema };
  }
  return { error: 'has no `__schema` object in it' };
}

function loadIntrospection(text: string, path: string): { schema?: Schema; error?: LoadError } {
  const i = introspectionOf(text);
  if (!i.schema) return { error: { message: `${path.split('/').pop()} ${i.error}.`, file: path } };
  let sdl: string;
  try {
    upgradeSpecifiedBy(i.schema);
    sdl = printSchema(buildClientSchema({ __schema: i.schema } as Parameters<typeof buildClientSchema>[0]));
  } catch (e) {
    return { error: { message: `the introspection result can't be read: ${e instanceof Error ? e.message : String(e)}`, file: path } };
  }
  const { doc, error } = parseSdl(sdl, path);
  if (!doc) return { error: { message: `the introspection result can't be read: ${error!.message}`, file: path } };
  const b = new Builder();
  b.schema.kind = 'introspection';
  b.add(doc, path);
  const s = b.finish();
  s.lacks = missingCapabilities(i.schema);
  relocate(s, jsonLocator(text, path));
  return { schema: s };
}

/**
 * graphql-js 15 servers send `specifiedByUrl`; buildClientSchema reads only `specifiedByURL`.
 * Copied over (on a copy of the type), so that the URL isn't lost.
 */
function upgradeSpecifiedBy(raw: unknown) {
  const s = raw as { types?: unknown };
  if (!s || typeof s !== 'object' || !Array.isArray(s.types)) return;
  s.types = s.types.map((t: unknown) => {
    const o = t as Record<string, unknown> | null;
    return o && typeof o === 'object' && o.kind === 'SCALAR' && !('specifiedByURL' in o) && 'specifiedByUrl' in o ? { ...o, specifiedByURL: o.specifiedByUrl } : t;
  });
}

/** What the introspection result doesn't say: no key for it anywhere it could be. */
function missingCapabilities(raw: unknown): Set<Capability> {
  const out = new Set<Capability>();
  const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';
  const list = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter(obj) : []);
  if (!obj(raw)) return out;
  const types = list(raw.types);
  const directives = list(raw.directives);
  const missing = (of: Record<string, unknown>[], ...keys: string[]) => of.length > 0 && !of.some((x) => keys.some((k) => k in x));
  if (missing(types.filter((t) => t.kind === 'INPUT_OBJECT'), 'isOneOf')) out.add('oneOf');
  if (missing(directives, 'isRepeatable')) out.add('repeatable');
  // graphql-js 15 named it `specifiedByUrl`; `loadIntrospection` copies it to the current key.
  if (missing(types.filter((t) => t.kind === 'SCALAR'), 'specifiedByURL', 'specifiedByUrl')) out.add('specifiedBy');
  const inputs = [...types.flatMap((t) => [...list(t.inputFields), ...list(t.fields).flatMap((f) => list(f.args))]), ...directives.flatMap((d) => list(d.args))];
  if (missing(inputs, 'isDeprecated')) out.add('inputDeprecation');
  return out;
}

/** Positions from the printed SDL mean nothing: point into the JSON instead, where it can be found. */
function relocate(s: Schema, at: Locator) {
  const fix = <T extends { pos?: Pos }>(x: T, p: Pos | undefined) => {
    x.pos = p;
  };
  for (const t of s.types.values()) {
    const tp = at.type(t.name);
    fix(t, tp);
    for (const d of t.directives) fix(d, tp);
    for (const f of t.fields.values()) {
      const fp = at.member(t.name, 'fields', f.name) ?? tp;
      fix(f, fp);
      for (const d of f.directives) fix(d, fp);
      for (const a of f.args.values()) {
        const ap = at.arg(t.name, 'fields', f.name, a.name) ?? fp;
        fix(a, ap);
        for (const d of a.directives) fix(d, ap);
      }
    }
    for (const f of t.inputFields.values()) {
      const fp = at.member(t.name, 'inputFields', f.name) ?? tp;
      fix(f, fp);
      for (const d of f.directives) fix(d, fp);
    }
    for (const v of t.values.values()) {
      const vp = at.member(t.name, 'enumValues', v.name) ?? tp;
      fix(v, vp);
      for (const d of v.directives) fix(d, vp);
    }
  }
  for (const d of s.directives.values()) {
    const dp = at.directive(d.name);
    fix(d, dp);
    for (const a of d.args.values()) fix(a, at.directiveArg(d.name, a.name) ?? dp);
  }
  s.schemaPos = at.schema();
}

// --- entry -----------------------------------------------------------------------------

export interface Loaded {
  schema?: Schema;
  error?: LoadError;
}

/**
 * Reads a side: an introspection result, or SDL merged with the other files of a split
 * schema. A main file that doesn't parse is an error; a sibling that doesn't is a warning
 * and is left out.
 */
export function loadSchema(side: Side): Loaded {
  const kind = looksLikeSchema(side.text) ?? (/^\s*\{/.test(side.text) ? 'introspection' : 'sdl');
  if (kind === 'introspection') return loadIntrospection(side.text, side.path);
  const main = parseSdl(side.text, side.path);
  if (!main.doc) return { error: main.error };
  if (!hasTypeSystem(main.doc)) return { error: { message: `${side.path.split('/').pop()} has no type definitions (only queries or fragments).`, file: side.path } };
  const b = new Builder();
  b.add(main.doc, side.path);
  // What the main file defines (not extends). A file next to it that defines its root
  // types or its schema block again, or most of what it defines, is another version of the
  // schema (`schema-v2.graphql`), not a part of it. One that only repeats a definition or
  // two is merged, and the repeats are reported like any other.
  const own = definedNames(main.doc);
  const ownShapes = definedNames(main.doc, true);
  const roots = new Set([...Object.values(DEFAULT_ROOTS), ...Object.values(b.schema.roots), '\0schema']);
  const versions: string[] = [];
  let clash = '';
  const files = [...(side.files ?? [])].filter((f) => f.path !== side.path).sort((x, y) => x.path.localeCompare(y.path));
  b.schema.warnings.push(...(side.warnings ?? []));
  if (files.length > MAX_FILES) b.schema.warnings.push(`Only the first ${MAX_FILES} of ${files.length} schema files were read.`);
  for (const f of files.slice(0, MAX_FILES)) {
    const r = parseSdl(f.text, f.path);
    if (!r.doc) {
      b.schema.warnings.push(`${f.path.split('/').pop()} was left out: ${r.error!.message}${r.error!.line !== undefined ? ` (line ${r.error!.line + 1})` : ''}.`);
      continue;
    }
    if (!hasTypeSystem(r.doc)) continue; // a query document that matched the pattern
    // Scalars are often declared again in each part that uses them: they
    // don't make a file another version. Only the types with members count.
    const shared = [...definedNames(r.doc)].filter((n) => own.has(n));
    const sharedShapes = shared.filter((n) => ownShapes.has(n));
    if (shared.length && (shared.some((n) => roots.has(n)) || (ownShapes.size > 0 && sharedShapes.length * 2 > ownShapes.size))) {
      versions.push(f.path.split('/').pop()!);
      clash ||= shared.find((n) => roots.has(n)) ?? shared[0];
      continue;
    }
    b.add(r.doc, f.path);
  }
  if (versions.length) {
    const names = versions.slice(0, 3).join(', ') + (versions.length > 3 ? ` and ${versions.length - 3} more` : '');
    const what = clash === '\0schema' ? 'the schema block' : `\`${clash}\``;
    b.schema.warnings.push(`${names} ${versions.length === 1 ? 'was' : 'were'} left out as another version of the schema: ${versions.length === 1 ? 'it defines' : 'they define'} ${what} again. The \`schemaFiles\` setting names the files that belong to it.`);
  }
  return { schema: b.finish() };
}

/** The types (and `schema` block) a document defines, not counting extensions. */
function definedNames(doc: DocumentNode, shapesOnly = false): Set<string> {
  const out = new Set<string>();
  for (const d of doc.definitions) {
    if (d.kind === Kind.SCHEMA_DEFINITION) {
      if (!shapesOnly) out.add('\0schema');
    } else if (d.kind in KIND_OF && !EXTENSIONS.has(d.kind) && !(shapesOnly && d.kind === Kind.SCALAR_TYPE_DEFINITION)) out.add((d as { name: { value: string } }).name.value);
  }
  return out;
}
