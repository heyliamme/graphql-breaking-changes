/**
 * Type references as written in SDL (`[String!]!`): parsed, and compared by what the
 * change means for a client.
 */
export type TypeRef = { kind: 'named'; name: string; nonNull: boolean } | { kind: 'list'; of: TypeRef; nonNull: boolean };

export function parseTypeRef(s: string): TypeRef {
  let t = s.trim();
  const nonNull = t.endsWith('!');
  if (nonNull) t = t.slice(0, -1).trim();
  if (t.startsWith('[') && t.endsWith(']')) return { kind: 'list', of: parseTypeRef(t.slice(1, -1)), nonNull };
  return { kind: 'named', name: t, nonNull };
}

/** The innermost type name: `[User!]!` → `User`. */
export function namedType(s: string): string {
  return s.replace(/[[\]!\s]/g, '');
}

export const isNonNull = (s: string) => s.trim().endsWith('!');

/**
 * How a client sees a type change. `output` for fields (what the client reads): becoming
 * non-null is safe, becoming nullable breaks a client that doesn't expect `null`. `input`
 * for arguments and input fields (what the client sends): the other way round.
 *
 * `changed`: another type, or list nesting changed. `breaking` / `safe`: only nullability
 * changed, in the bad or the good direction (any bad one wins). `same`: equal.
 */
export type TypeChange = 'same' | 'safe' | 'breaking' | 'changed';

export interface TypeComparison {
  result: TypeChange;
  /** The outermost wrapper became non-null (an argument became required, a field never null). */
  topTightened: boolean;
  /** The outermost wrapper became nullable. */
  topLoosened: boolean;
}

export function compareTypeRefs(oldS: string, newS: string, direction: 'output' | 'input'): TypeComparison {
  const a = parseTypeRef(oldS);
  const b = parseTypeRef(newS);
  const none = { topTightened: false, topLoosened: false };
  if (oldS.replace(/\s+/g, '') === newS.replace(/\s+/g, '')) return { result: 'same', ...none };
  let tightened = false;
  let loosened = false;
  let x: TypeRef | undefined = a;
  let y: TypeRef | undefined = b;
  for (;;) {
    if (x.kind !== y.kind) return { result: 'changed', ...none };
    if (x.nonNull !== y.nonNull) {
      if (y.nonNull) tightened = true;
      else loosened = true;
    }
    if (x.kind === 'named' || y.kind === 'named') {
      if (x.kind === 'named' && y.kind === 'named' && x.name !== y.name) return { result: 'changed', ...none };
      break;
    }
    x = x.of;
    y = y.of;
  }
  const topTightened = !a.nonNull && b.nonNull;
  const topLoosened = a.nonNull && !b.nonNull;
  // Output: tightening is safe. Input: loosening is safe.
  const bad = direction === 'output' ? loosened : tightened;
  const good = direction === 'output' ? tightened : loosened;
  return { result: bad ? 'breaking' : good ? 'safe' : 'same', topTightened, topLoosened };
}
