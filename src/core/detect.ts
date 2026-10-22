/**
 * Whether a document is a GraphQL schema, by content, and which kind: SDL (type system
 * definitions) or an introspection result (`__schema`, as codegen and Apollo write it).
 */
export type SchemaKind = 'sdl' | 'introspection';

/** A type system definition or extension at the start of a line. */
const DEFINITION =
  /^[ \t]*(?:extend[ \t]+)?(?:(?:type|interface|input|enum)[ \t]+[_A-Za-z]\w*[ \t]*(?:implements\b|@|\{|$)|union[ \t]+[_A-Za-z]\w*[ \t]*(?:@|=|$)|scalar[ \t]+[_A-Za-z]\w*[ \t]*(?:@|$)|schema[ \t]*(?:@|\{)|directive[ \t]*@[_A-Za-z]\w*)/m;

/** What only a schema has: a root type, a schema block, or an introspection result. */
const STRONG = /^[ \t]*(?:extend[ \t]+)?(?:type[ \t]+(?:Query|Mutation|Subscription)\b|schema[ \t]*(?:@|\{))/m;

/**
 * `strict` asks for a root type or a schema block, for files that aren't called
 * `.graphql`: `enum Color {` alone is also TypeScript.
 */
export function looksLikeSchema(text: string, strict = false): SchemaKind | undefined {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (/^\s*\{/.test(t)) return looksLikeIntrospection(t) ? 'introspection' : undefined;
  if (STRONG.test(t)) return 'sdl';
  if (!strict && DEFINITION.test(t)) return 'sdl';
  return undefined;
}

/** A JSON object with `__schema` near the top: `{"__schema": …}` or `{"data": {"__schema": …}}`. */
export function looksLikeIntrospection(t: string): boolean {
  // The key is within the first few hundred bytes in every writer's output; a large
  // file is not scanned whole.
  const head = t.slice(0, 4096);
  return /"__schema"\s*:\s*\{/.test(head);
}
