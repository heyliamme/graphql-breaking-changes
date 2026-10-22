export type Level = 'error' | 'warning' | 'info';

export const LEVEL_ORDER: Record<Level, number> = { error: 0, warning: 1, info: 2 };

/** Where something is in a source file: 0-based line and column. */
export interface Loc {
  file: string;
  /** A JSON-pointer-like path in the schema: `/types/User/fields/email/args/first`. */
  pointer: string;
  line: number;
  col: number;
}

export interface LoadError {
  message: string;
  file: string;
  line?: number;
  col?: number;
}

export type TypeKind = 'SCALAR' | 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT';

/** Which part of the schema a change is on, for grouping and the kind badge. */
export type Kind = TypeKind | 'DIRECTIVE' | 'SCHEMA';

export const KIND_NAME: Record<Kind, string> = {
  SCALAR: 'scalar',
  OBJECT: 'type',
  INTERFACE: 'interface',
  UNION: 'union',
  ENUM: 'enum',
  INPUT_OBJECT: 'input',
  DIRECTIVE: 'directive',
  SCHEMA: 'schema',
};
