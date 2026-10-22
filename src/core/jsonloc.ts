/**
 * Where things are in an introspection JSON file, so a change can open it at the type or
 * field. One pass over the text records the `name` keys and the section keys with their
 * nesting depth; a type is a `name` at the depth of `__schema.types[i]`, a field a `name`
 * two levels deeper inside its `fields` section, an argument two deeper again. Best
 * effort: a file written in some other shape just points at the top.
 */
import type { Pos } from './model';

interface KeyAt {
  key: string;
  depth: number;
  line: number;
  col: number;
  /** For `name` keys: the string value. */
  value?: string;
}

// `type`, `interfaces` and `possibleTypes` hold type references whose `name`s must not be taken for members.
const WANTED = new Set(['name', '__schema', 'types', 'directives', 'fields', 'inputFields', 'enumValues', 'args', 'type', 'interfaces', 'possibleTypes']);

export interface Locator {
  schema(): Pos | undefined;
  type(name: string): Pos | undefined;
  member(type: string, section: 'fields' | 'inputFields' | 'enumValues', name: string): Pos | undefined;
  arg(type: string, section: 'fields', field: string, name: string): Pos | undefined;
  directive(name: string): Pos | undefined;
  directiveArg(directive: string, name: string): Pos | undefined;
}

/** Scans the keys of a JSON text. Strings are skipped whole; nothing is parsed. */
function scan(text: string): KeyAt[] {
  const keys: KeyAt[] = [];
  let depth = 0;
  let line = 0;
  let lineStart = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      line++;
      lineStart = i + 1;
    } else if (c === 123 || c === 91) depth++;
    else if (c === 125 || c === 93) depth--;
    else if (c === 34) {
      const start = i + 1;
      let j = start;
      let escaped = false;
      for (; j < n; j++) {
        const d = text.charCodeAt(j);
        if (escaped) escaped = false;
        else if (d === 92) escaped = true;
        else if (d === 34) break;
        else if (d === 10) {
          line++;
          lineStart = j + 1;
        }
      }
      const s = text.slice(start, j);
      // A key: the next non-space character is a colon. (Lines are counted by the outer
      // loop, which passes this whitespace again after the string.)
      let k = j + 1;
      for (; k < n; k++) {
        const d = text.charCodeAt(k);
        if (d !== 32 && d !== 9 && d !== 13 && d !== 10) break;
      }
      if (text.charCodeAt(k) === 58 && WANTED.has(s)) {
        const at: KeyAt = { key: s, depth, line, col: i - lineStart };
        if (s === 'name') {
          // The value: a string right after the colon.
          let v = k + 1;
          while (v < n && (text.charCodeAt(v) === 32 || text.charCodeAt(v) === 10 || text.charCodeAt(v) === 13 || text.charCodeAt(v) === 9)) v++;
          if (text.charCodeAt(v) === 34) {
            const e = text.indexOf('"', v + 1);
            if (e > v) at.value = text.slice(v + 1, e);
          }
        }
        keys.push(at);
      }
      i = j;
    }
  }
  return keys;
}

/** A type or directive entry: where its keys start and end. */
interface Entry {
  at: KeyAt;
  start: number;
  end: number;
  /** Built on first use: members by section, and arguments by field. */
  members?: Map<string, Map<string, KeyAt>>;
  args?: Map<string, Map<string, KeyAt>>;
}

export function jsonLocator(text: string, file: string): Locator {
  const none: Locator = { schema: () => undefined, type: () => undefined, member: () => undefined, arg: () => undefined, directive: () => undefined, directiveArg: () => undefined };
  let keys: KeyAt[];
  try {
    keys = scan(text);
  } catch {
    return none;
  }
  const rootIndex = keys.findIndex((k) => k.key === '__schema');
  if (rootIndex < 0) return none;
  const root = keys[rootIndex];
  const d0 = root.depth;
  const pos = (k: KeyAt): Pos => ({ file, line: k.line, col: k.col });

  /** The entries of the `types` or `directives` array: each `name` at depth d0 + 3, up to the next. */
  const entries = (list: 'types' | 'directives'): Map<string, Entry> => {
    const out = new Map<string, Entry>();
    let i = rootIndex + 1;
    for (; i < keys.length; i++) {
      if (keys[i].depth <= d0) return out;
      if (keys[i].key === list && keys[i].depth === d0 + 1) break;
    }
    let current: Entry | undefined;
    for (i++; i < keys.length; i++) {
      const k = keys[i];
      if (k.depth <= d0 + 1) break; // the array ended
      if (k.key === 'name' && k.depth === d0 + 3) {
        if (current) current.end = i;
        current = { at: k, start: i, end: keys.length };
        if (k.value !== undefined && !out.has(k.value)) out.set(k.value, current);
      }
    }
    if (current) current.end = i;
    return out;
  };
  let types: Map<string, Entry> | undefined;
  let directives: Map<string, Entry> | undefined;
  const typeOf = (name: string) => (types ??= entries('types')).get(name);
  const directiveOf = (name: string) => (directives ??= entries('directives')).get(name);

  /** One pass over an entry's keys: its sections' members (depth + 2) and each field's args (depth + 4). */
  const index = (e: Entry, d: number) => {
    if (e.members) return;
    e.members = new Map();
    e.args = new Map();
    let section: Map<string, KeyAt> | undefined;
    let field: string | undefined;
    let args: Map<string, KeyAt> | undefined;
    for (let i = e.start + 1; i < e.end; i++) {
      const k = keys[i];
      if (k.depth === d && k.key !== 'name') {
        // A section of the entry itself: fields, inputFields, enumValues; or a directive's args.
        section = new Map();
        e.members.set(k.key, section);
        field = undefined;
        args = undefined;
      } else if (k.depth === d + 2 && k.key === 'name' && section && k.value !== undefined) {
        if (!section.has(k.value)) section.set(k.value, k);
        field = k.value;
        args = undefined;
      } else if (k.depth === d + 2 && k.key === 'args' && field !== undefined) {
        args = new Map();
        if (!e.args.has(field)) e.args.set(field, args);
      } else if (k.depth === d + 2 && k.key === 'type') args = undefined; // the field's own type follows its args
      else if (k.depth === d + 4 && k.key === 'name' && args && k.value !== undefined && !args.has(k.value)) args.set(k.value, k);
    }
  };
  return {
    schema: () => pos(root),
    type: (name) => {
      const e = typeOf(name);
      return e && pos(e.at);
    },
    member: (type, sec, name) => {
      const e = typeOf(type);
      if (!e) return undefined;
      index(e, d0 + 3);
      const k = e.members!.get(sec)?.get(name);
      return k && pos(k);
    },
    arg: (type, _sec, fieldName, name) => {
      const e = typeOf(type);
      if (!e) return undefined;
      index(e, d0 + 3);
      const k = e.args!.get(fieldName)?.get(name);
      return k && pos(k);
    },
    directive: (name) => {
      const e = directiveOf(name);
      return e && pos(e.at);
    },
    directiveArg: (directive, name) => {
      const e = directiveOf(directive);
      if (!e) return undefined;
      index(e, d0 + 3);
      const k = e.members!.get('args')?.get(name);
      return k && pos(k);
    },
  };
}
