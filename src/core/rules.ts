import type { Level } from './types';

export type { Level };
export { LEVEL_ORDER } from './types';

/** A level, or "breaking when …, else …" for the changes that depend on context. */
export type RuleLevel = Level | { varies: string };

export interface Rule {
  id: string;
  level: RuleLevel;
  /** What happened, in a few words, for the README table. */
  summary: string;
  group: string;
}

const r = (group: string, id: string, level: RuleLevel, summary: string): Rule => ({ id, level, summary, group });

const BASE: Rule[] = [
  r('Schema', 'schema-root-changed', 'error', 'The query, mutation or subscription root is another type'),
  r('Schema', 'schema-root-removed', 'error', 'The mutation or subscription root type was removed'),
  r('Schema', 'schema-root-added', 'info', 'A mutation or subscription root type was added'),
  r('Schema', 'schema-description-changed', 'info', "The schema's description changed"),

  r('Types', 'type-added', 'info', 'A type was added'),
  r('Types', 'type-removed', 'error', 'A type was removed'),
  r('Types', 'type-kind-changed', 'error', 'A type changed kind (object type → interface, enum → scalar, …)'),
  r('Types', 'type-description-changed', 'info', "A type's description changed"),
  r('Types', 'scalar-specified-by-changed', 'info', '`@specifiedBy` of a scalar was added, removed or changed'),

  r('Fields', 'field-added', 'info', 'A field was added to an object type or interface'),
  r('Fields', 'field-removed', 'error', 'A field was removed'),
  r('Fields', 'deprecated-field-removed', 'warning', 'A deprecated field was removed'),
  r('Fields', 'field-type-changed', 'error', "A field's type changed (another type, or other list nesting)"),
  r('Fields', 'field-became-nullable', 'error', 'A field, or the items of a list field, can now be `null`'),
  r('Fields', 'field-became-non-null', 'info', 'A field, or the items of a list field, can no longer be `null`'),
  r('Fields', 'field-deprecated', 'info', 'A field was marked deprecated'),
  r('Fields', 'field-deprecation-removed', 'info', 'A field is no longer deprecated'),
  r('Fields', 'field-deprecation-reason-changed', 'info', "A field's deprecation reason changed"),
  r('Fields', 'field-description-changed', 'info', "A field's description changed"),

  r('Input objects', 'input-one-of-added', 'error', '`@oneOf` was added: exactly one field must now be given'),
  r('Input objects', 'input-one-of-removed', 'info', '`@oneOf` was removed'),

  r('Enums', 'enum-value-added', { varies: 'dangerous when a field returns the enum (exhaustive switches break), else info' }, 'An enum value was added'),
  r('Enums', 'enum-value-removed', 'error', 'An enum value was removed'),
  r('Enums', 'deprecated-enum-value-removed', 'warning', 'A deprecated enum value was removed'),
  r('Enums', 'enum-value-deprecated', 'info', 'An enum value was marked deprecated'),
  r('Enums', 'enum-value-deprecation-removed', 'info', 'An enum value is no longer deprecated'),
  r('Enums', 'enum-value-deprecation-reason-changed', 'info', "An enum value's deprecation reason changed"),
  r('Enums', 'enum-value-description-changed', 'info', "An enum value's description changed"),

  r('Unions and interfaces', 'union-member-added', 'warning', 'A type was added to a union (fragments that cover every member stop doing so)'),
  r('Unions and interfaces', 'union-member-removed', 'error', 'A type was removed from a union'),
  r('Unions and interfaces', 'interface-implementation-added', { varies: 'dangerous for an object type and an interface that already existed (fragments that cover every implementor stop doing so); info for an interface, which is never returned itself, or an interface that is new too' }, 'A type now implements an interface'),
  r('Unions and interfaces', 'interface-implementation-removed', 'error', 'A type no longer implements an interface'),

  r('Directives', 'directive-added', 'info', 'A directive was defined'),
  r('Directives', 'directive-removed', 'error', 'A directive definition was removed'),
  r('Directives', 'directive-location-added', 'info', 'A directive can be used in a new location'),
  r('Directives', 'directive-location-removed', 'error', 'A directive can no longer be used in a location'),
  r('Directives', 'directive-repeatable-added', 'info', 'A directive became repeatable'),
  r('Directives', 'directive-repeatable-removed', 'error', 'A directive is no longer repeatable'),
  r('Directives', 'directive-description-changed', 'info', "A directive's description changed"),

  r('Directive usage', 'directive-usage-added', 'info', 'A directive was applied somewhere (`@key`, `@shareable`, `@auth`, …)'),
  r('Directive usage', 'directive-usage-removed', 'info', 'A directive is no longer applied somewhere'),
  r('Directive usage', 'directive-usage-changed', 'info', 'The arguments of an applied directive changed'),
];

/** The same rules apply to field arguments, input fields and directive arguments: what the client sends. */
export const INPUT_PREFIXES = ['argument', 'input-field', 'directive-argument'] as const;
export type InputPrefix = (typeof INPUT_PREFIXES)[number];

const INPUT_GROUP: Record<InputPrefix, string> = { argument: 'Arguments', 'input-field': 'Input objects', 'directive-argument': 'Directives' };
const INPUT_NOUN: Record<InputPrefix, string> = { argument: 'argument', 'input-field': 'input field', 'directive-argument': 'directive argument' };

interface InputRule {
  rule: string;
  level: RuleLevel;
  /** `%s` is the noun: "argument", "input field", "directive argument". */
  summary: string;
}

export const INPUT_RULES: InputRule[] = [
  { rule: 'added', level: { varies: 'dangerous when it has a default value (the server now does something for clients that omit it), else info' }, summary: 'An optional %s was added' },
  { rule: 'added-required', level: 'error', summary: 'A required %s (non-null, no default) was added' },
  { rule: 'removed', level: { varies: "breaking; dangerous when the new side is an introspection result made without `isDeprecated` on input values, which leaves deprecated ones out (it may only have been deprecated)" }, summary: 'A %s was removed' },
  { rule: 'deprecated-removed', level: 'warning', summary: 'A deprecated %s was removed' },
  { rule: 'type-changed', level: 'error', summary: "A %s's type changed (another type, or other list nesting)" },
  { rule: 'became-required', level: 'error', summary: 'A %s became required: non-null without a default, or its default was removed' },
  { rule: 'became-non-null', level: { varies: 'breaking; dangerous when a default value was added with it' }, summary: 'A %s, or the items of a list %s, can no longer be `null`' },
  { rule: 'became-nullable', level: 'info', summary: 'A %s, or the items of a list %s, can now be `null`' },
  { rule: 'default-added', level: { varies: 'dangerous (the server now does something for clients that omit it); info when the %s was required before, so clients always send it' }, summary: 'A default value was added' },
  { rule: 'default-changed', level: 'warning', summary: 'The default value changed' },
  { rule: 'default-removed', level: 'warning', summary: 'The default value of a nullable %s was removed (omitting it now means `null`)' },
  { rule: 'deprecated', level: 'info', summary: 'A %s was marked deprecated' },
  { rule: 'deprecation-removed', level: 'info', summary: 'A %s is no longer deprecated' },
  { rule: 'deprecation-reason-changed', level: 'info', summary: "A %s's deprecation reason changed" },
  { rule: 'description-changed', level: 'info', summary: "A %s's description changed" },
];

/** `%s` replaced by the noun, with the article before it agreeing: "An argument", "a directive argument". */
function noun(text: string, p: InputPrefix): string {
  const n = INPUT_NOUN[p];
  const an = /^[aeiou]/.test(n);
  return text.replace(/\b([Aa]) %s/g, (_, a: string) => `${a}${an ? 'n' : ''} ${n}`).replace(/%s/g, n);
}

/** The id of an input-value rule: `argument-became-required`, `deprecated-input-field-removed`. */
export function inputId(prefix: InputPrefix, rule: string): string {
  return rule === 'deprecated-removed' ? `deprecated-${prefix}-removed` : `${prefix}-${rule}`;
}

let catalog: Rule[] | undefined;

/** Every id a comparison can report, with its level and a summary, in README order. */
export function allRules(): Rule[] {
  if (catalog) return catalog;
  const out: Rule[] = [];
  const groups = ['Schema', 'Types', 'Fields', 'Arguments', 'Input objects', 'Enums', 'Unions and interfaces', 'Directives', 'Directive usage'];
  const expanded = (p: InputPrefix): Rule[] =>
    INPUT_RULES.map((x) => ({ id: inputId(p, x.rule), level: typeof x.level === 'string' ? x.level : { varies: noun(x.level.varies, p) }, summary: noun(x.summary, p), group: INPUT_GROUP[p] }));
  for (const g of groups) {
    const own = BASE.filter((b) => b.group === g);
    const prefix = INPUT_PREFIXES.find((p) => INPUT_GROUP[p] === g);
    // A directive's own rules before its arguments'; an input object's fields before @oneOf.
    if (!prefix) out.push(...own);
    else if (g === 'Directives') out.push(...own, ...expanded(prefix));
    else out.push(...expanded(prefix), ...own);
  }
  return (catalog = out);
}

export function ruleLevel(id: string): RuleLevel | undefined {
  return allRules().find((x) => x.id === id)?.level;
}
