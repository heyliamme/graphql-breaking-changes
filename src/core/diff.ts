import { codeSpan } from './md';
import { DEFAULT_ROOTS, KIND_WORD, ROOT_OPS, type Capability, type Directive, type DirectiveDef, type EnumValue, type Field, type InputValue, type Lit, type Pos, type RootOp, type Schema, type TypeDef } from './model';
import { inputId, type InputPrefix, type Level } from './rules';
import { compareTypeRefs, namedType } from './typeref';
import type { Kind, Loc } from './types';

export interface Change {
  /** Stable id, such as `field-removed`. */
  id: string;
  level: Level;
  message: string;
  /** What the change is on: a type kind, a directive definition, or the schema itself. */
  kind: Kind;
  /** The type's name, `@name` for a directive; none for the schema. */
  type?: string;
  /** The field, input field or enum value; for an argument, the field it belongs to. */
  field?: string;
  old?: Loc;
  new?: Loc;
  /**
   * For a change with no place in the new schema (a removal): the closest part of it that
   * is still there (the type of a removed field, the field of a removed argument, else the
   * top of the file), for the Problems panel.
   */
  anchor?: Loc;
  /** Set by ignore rules: the reason, or "" when none was given. */
  ignored?: string;
}

const code = codeSpan;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const at = (p: Pos | undefined, pointer: string): Loc | undefined => (p ? { file: p.file, pointer, line: p.line, col: p.col } : undefined);

/** A JSON-pointer segment. */
const seg = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

interface Where {
  kind: Kind;
  type?: string;
  field?: string;
  pointer: string;
}

/**
 * What a `@deprecated` says, for messages: "(deprecated: use `b`)" or "(deprecated)".
 */
const deprecation = (d?: { reason?: string }) => (!d ? '' : d.reason ? ` (deprecated: ${code(d.reason)})` : ' (deprecated)');

/** What an introspection result that leaves a capability out can't tell, for the warning. */
const CAPABILITY: Record<Capability, { key: string; what: string }> = {
  oneOf: { key: '`isOneOf`', what: '`@oneOf` on input types was' },
  repeatable: { key: '`isRepeatable`', what: 'whether directives are repeatable was' },
  inputDeprecation: { key: '`isDeprecated` on arguments and input fields', what: 'deprecated arguments and input fields were' },
  specifiedBy: { key: '`specifiedByURL`', what: '`@specifiedBy` of scalars was' },
};

class Differ {
  changes: Change[] = [];
  /** Differences left out because one side's introspection result doesn't say. */
  private skipped = new Set<Capability>();
  /** Where a removal of something with no closer surviving parent shows: the schema block, else the main file's top. */
  private top: Pos | undefined;
  /** Enums some field returns, in the new schema: a new value reaches clients. */
  private outputEnums = new Set<string>();
  private implementorsNew = new Map<string, string[]>();
  private implementorsOld = new Map<string, string[]>();

  constructor(
    private a: Schema,
    private b: Schema,
  ) {
    for (const t of b.types.values()) {
      if (t.kind === 'OBJECT' || t.kind === 'INTERFACE') for (const f of t.fields.values()) this.outputEnums.add(namedType(f.type));
      for (const i of t.interfaces) this.implementorsNew.set(i, [...(this.implementorsNew.get(i) ?? []), t.name]);
    }
    for (const t of a.types.values()) for (const i of t.interfaces) this.implementorsOld.set(i, [...(this.implementorsOld.get(i) ?? []), t.name]);
    this.top = b.schemaPos ?? (b.files[0] ? { file: b.files[0], line: 0, col: 0 } : undefined);
  }

  private add(id: string, level: Level, message: string, w: Where, oldPos?: Pos, newPos?: Pos, anchor?: Pos) {
    const c: Change = { id, level, message, kind: w.kind, type: w.type, field: w.field, old: at(oldPos, w.pointer), new: at(newPos, w.pointer) };
    if (!newPos) {
      const a = at(anchor ?? this.top, w.pointer);
      if (a) c.anchor = a;
    }
    this.changes.push(c);
  }

  /** A file of the old schema that the new one still has, at its top; else the schema's top. */
  private sameFile(p: Pos | undefined): Pos | undefined {
    return p && this.b.files.includes(p.file) ? { file: p.file, line: 0, col: 0 } : undefined;
  }

  /** One side's introspection result doesn't say: the difference is not reported. */
  private lacks(c: Capability): boolean {
    return this.a.lacks.has(c) || this.b.lacks.has(c);
  }

  private skip(c: Capability) {
    this.skipped.add(c);
  }

  /** Why some differences were left out. */
  warnings(): string[] {
    return [...this.skipped].map((c) => {
      const sides = [this.a.lacks.has(c) && 'old', this.b.lacks.has(c) && 'new'].filter(Boolean).join(' and ');
      return `The ${sides} introspection result has no ${CAPABILITY[c].key} (it was made without asking for ${c === 'inputDeprecation' ? 'them' : 'it'}), so ${CAPABILITY[c].what} not compared.`;
    });
  }

  run(): Change[] {
    this.schema();
    const names = new Set([...this.a.types.keys(), ...this.b.types.keys()]);
    for (const name of [...names].sort()) this.type(name);
    const dirs = new Set([...this.a.directives.keys(), ...this.b.directives.keys()]);
    for (const name of [...dirs].sort()) this.directive(name);
    return this.changes;
  }

  // --- schema -----------------------------------------------------------------------------

  private schema() {
    const w: Where = { kind: 'SCHEMA', pointer: '/schema' };
    const a = this.a;
    const b = this.b;
    for (const op of ROOT_OPS) {
      const o = a.roots[op];
      const n = b.roots[op];
      const wo: Where = { ...w, pointer: `/schema/${op}` };
      if (o === n) continue;
      if (o && n) this.add('schema-root-changed', 'error', `The ${op} root type is now ${code(n)} (was ${code(o)})`, wo, a.schemaPos, b.schemaPos);
      else if (o) {
        // A removed root whose type went too is one change, the type's.
        if (!b.types.has(o) && !a.explicitRoots) continue;
        this.add('schema-root-removed', 'error', `The ${op} root type ${code(o)} was removed: ${op === 'query' ? 'queries' : op === 'mutation' ? 'mutations' : 'subscriptions'} are no longer possible`, wo, a.schemaPos, b.schemaPos);
      } else if (n) {
        if (!a.types.has(n) && !b.explicitRoots) continue;
        this.add('schema-root-added', 'info', `${cap(op)} root type ${code(n)} added`, wo, a.schemaPos, b.schemaPos);
      }
    }
    this.description('schema-description-changed', 'The schema', a.description, b.description, w, a.schemaPos, b.schemaPos);
    this.usage(a.schemaDirectives, b.schemaDirectives, 'the schema', w, a.schemaPos, b.schemaPos);
  }

  // --- types -------------------------------------------------------------------------------

  private type(name: string) {
    const o = this.a.types.get(name);
    const n = this.b.types.get(name);
    const w: Where = { kind: (n ?? o)!.kind, type: name, pointer: `/types/${seg(name)}` };
    if (!o) {
      this.add('type-added', 'info', `${cap(KIND_WORD[n!.kind])} ${code(name)} added`, w, undefined, n!.pos);
      // A new implementor of an existing interface reaches clients as much as a new union member.
      // An interface is never returned itself: only a new object type reaches clients.
      if (n!.kind === 'OBJECT')
        for (const i of n!.interfaces)
          if (this.a.types.get(i)?.kind === 'INTERFACE') this.add('interface-implementation-added', 'warning', `New ${KIND_WORD[n!.kind]} ${code(name)} implements ${code(i)}: it can be returned where ${code(i)} is`, { ...w, pointer: `${w.pointer}/interfaces/${seg(i)}` }, undefined, n!.pos);
      return;
    }
    if (!n) return this.add('type-removed', 'error', `${cap(KIND_WORD[o.kind])} ${code(name)} removed`, w, o.pos, undefined, this.sameFile(o.pos));
    if (o.kind !== n.kind) {
      const a = (k: string) => (/^[aeiou]/.test(k) ? `an ${k}` : `a ${k}`);
      return this.add('type-kind-changed', 'error', `${code(name)} changed from ${a(KIND_WORD[o.kind])} to ${a(KIND_WORD[n.kind])}`, w, o.pos, n.pos);
    }
    this.description('type-description-changed', `${cap(KIND_WORD[n.kind])} ${code(name)}`, o.description, n.description, w, o.pos, n.pos);
    this.usage(o.directives, n.directives, `${KIND_WORD[n.kind]} ${code(name)}`, w, o.pos, n.pos);
    switch (n.kind) {
      case 'SCALAR':
        if (o.specifiedBy !== n.specifiedBy && this.lacks('specifiedBy')) this.skip('specifiedBy');
        else if (o.specifiedBy !== n.specifiedBy) {
          const how = o.specifiedBy === undefined ? `added: ${code(n.specifiedBy)}` : n.specifiedBy === undefined ? `removed (was ${code(o.specifiedBy)})` : `changed from ${code(o.specifiedBy)} to ${code(n.specifiedBy)}`;
          this.add('scalar-specified-by-changed', 'info', `${code('@specifiedBy')} of scalar ${code(name)} ${how}`, w, o.pos, n.pos);
        }
        break;
      case 'OBJECT':
      case 'INTERFACE':
        this.interfaces(o, n, w);
        this.fields(o, n, w);
        break;
      case 'UNION':
        this.members(o, n, w);
        break;
      case 'ENUM':
        this.values(o, n, w);
        break;
      case 'INPUT_OBJECT':
        this.inputFields(o, n, w);
        break;
    }
  }

  private interfaces(o: TypeDef, n: TypeDef, w: Where) {
    const what = KIND_WORD[n.kind];
    const object = n.kind === 'OBJECT';
    for (const i of o.interfaces) if (!n.interfaces.includes(i)) this.add('interface-implementation-removed', 'error', `${cap(what)} ${code(n.name)} no longer implements ${code(i)}${object ? `: it is no longer returned where ${code(i)} is` : ''}`, { ...w, pointer: `${w.pointer}/interfaces/${seg(i)}` }, o.pos, n.pos);
    // An interface implementing another is never returned in its place: its implementors already list both.
    for (const i of n.interfaces)
      if (!o.interfaces.includes(i)) {
        // No client can be querying an interface that is new itself.
        if (object && this.a.types.get(i)?.kind === 'INTERFACE') this.add('interface-implementation-added', 'warning', `${cap(what)} ${code(n.name)} now implements ${code(i)}: it can be returned where ${code(i)} is`, { ...w, pointer: `${w.pointer}/interfaces/${seg(i)}` }, o.pos, n.pos);
        else this.add('interface-implementation-added', 'info', `${cap(what)} ${code(n.name)} now implements ${code(i)}`, { ...w, pointer: `${w.pointer}/interfaces/${seg(i)}` }, o.pos, n.pos);
      }
  }

  private members(o: TypeDef, n: TypeDef, w: Where) {
    for (const m of o.members) if (!n.members.includes(m)) this.add('union-member-removed', 'error', `${code(m)} removed from union ${code(n.name)}`, { ...w, field: m, pointer: `${w.pointer}/members/${seg(m)}` }, o.pos, n.pos);
    for (const m of n.members) if (!o.members.includes(m)) this.add('union-member-added', 'warning', `${code(m)} added to union ${code(n.name)}: queries that cover every member no longer do`, { ...w, field: m, pointer: `${w.pointer}/members/${seg(m)}` }, o.pos, n.pos);
  }

  /** "(implemented by A, B)" for an interface field, naming what the change reaches. */
  private implementedBy(t: TypeDef, removed: boolean): string {
    if (t.kind !== 'INTERFACE') return '';
    const by = (removed ? this.implementorsOld : this.implementorsNew).get(t.name) ?? [];
    if (!by.length) return '';
    const shown = by.slice(0, 3).map(code).join(', ');
    return ` (implemented by ${shown}${by.length > 3 ? ` and ${by.length - 3} more` : ''})`;
  }

  private fields(o: TypeDef, n: TypeDef, w: Where) {
    const names = new Set([...o.fields.keys(), ...n.fields.keys()]);
    for (const name of names) {
      const of = o.fields.get(name);
      const nf = n.fields.get(name);
      const full = code(`${n.name}.${name}`);
      const wf: Where = { ...w, field: name, pointer: `${w.pointer}/fields/${seg(name)}` };
      if (!of) {
        this.add('field-added', 'info', `Field ${full} added${nf!.deprecated ? deprecation(nf!.deprecated) : ''}${this.implementedBy(n, false)}`, wf, undefined, nf!.pos);
        continue;
      }
      if (!nf) {
        if (of.deprecated) this.add('deprecated-field-removed', 'warning', `Deprecated field ${full} removed${deprecation(of.deprecated)}${this.implementedBy(o, true)}`, wf, of.pos, undefined, n.pos);
        else this.add('field-removed', 'error', `Field ${full} removed${this.implementedBy(o, true)}`, wf, of.pos, undefined, n.pos);
        continue;
      }
      const suffix = this.implementedBy(n, false);
      const t = compareTypeRefs(of.type, nf.type, 'output');
      const types = `${code(of.type)} → ${code(nf.type)}`;
      if (t.result === 'changed') this.add('field-type-changed', 'error', `Field ${full} changed type: ${types}${suffix}`, wf, of.pos, nf.pos);
      else if (t.result === 'breaking') this.add('field-became-nullable', 'error', `Field ${full} ${t.topLoosened ? 'can now be' : 'can now hold'} ${code('null')}: ${types}${suffix}`, wf, of.pos, nf.pos);
      else if (t.result === 'safe') this.add('field-became-non-null', 'info', `Field ${full} ${t.topTightened ? 'is now non-null' : 'no longer holds ' + code('null')}: ${types}${suffix}`, wf, of.pos, nf.pos);
      this.deprecated('field', `Field ${full}`, of.deprecated, nf.deprecated, wf, of.pos, nf.pos);
      this.description('field-description-changed', `Field ${full}`, of.description, nf.description, wf, of.pos, nf.pos);
      this.usage(of.directives, nf.directives, `field ${full}`, wf, of.pos, nf.pos);
      this.inputValues('argument', of.args, nf.args, (a) => `${a} of ${full}`, wf, `${wf.pointer}/args`, undefined, nf.pos);
    }
  }

  private values(o: TypeDef, n: TypeDef, w: Where) {
    const names = new Set([...o.values.keys(), ...n.values.keys()]);
    const returned = this.outputEnums.has(n.name);
    for (const name of names) {
      const ov = o.values.get(name);
      const nv = n.values.get(name);
      const full = code(`${n.name}.${name}`);
      const wv: Where = { ...w, field: name, pointer: `${w.pointer}/values/${seg(name)}` };
      if (!ov) {
        if (returned) this.add('enum-value-added', 'warning', `Enum value ${full} added: fields return ${code(n.name)}, so clients with an exhaustive switch may break${deprecation(nv!.deprecated)}`, wv, undefined, nv!.pos);
        else this.add('enum-value-added', 'info', `Enum value ${full} added${deprecation(nv!.deprecated)}`, wv, undefined, nv!.pos);
        continue;
      }
      if (!nv) {
        if (ov.deprecated) this.add('deprecated-enum-value-removed', 'warning', `Deprecated enum value ${full} removed${deprecation(ov.deprecated)}`, wv, ov.pos, undefined, n.pos);
        else this.add('enum-value-removed', 'error', `Enum value ${full} removed`, wv, ov.pos, undefined, n.pos);
        continue;
      }
      this.deprecated('enum-value', `Enum value ${full}`, ov.deprecated, nv.deprecated, wv, ov.pos, nv.pos);
      this.description('enum-value-description-changed', `Enum value ${full}`, ov.description, nv.description, wv, ov.pos, nv.pos);
      this.usage(ov.directives, nv.directives, `enum value ${full}`, wv, ov.pos, nv.pos);
    }
  }

  private inputFields(o: TypeDef, n: TypeDef, w: Where) {
    if (o.oneOf !== n.oneOf && this.lacks('oneOf')) this.skip('oneOf');
    else if (!o.oneOf && n.oneOf) this.add('input-one-of-added', 'error', `${code('@oneOf')} added to input type ${code(n.name)}: exactly one field must now be given`, { ...w, pointer: `${w.pointer}/oneOf` }, o.pos, n.pos);
    else if (o.oneOf && !n.oneOf) this.add('input-one-of-removed', 'info', `${code('@oneOf')} removed from input type ${code(n.name)}`, { ...w, pointer: `${w.pointer}/oneOf` }, o.pos, n.pos);
    this.inputValues('input-field', o.inputFields, n.inputFields, (f) => f, w, `${w.pointer}/inputFields`, n.name, n.pos);
  }

  // --- directives (definitions) ----------------------------------------------------------

  private directive(name: string) {
    const o = this.a.directives.get(name);
    const n = this.b.directives.get(name);
    const full = code(`@${name}`);
    const w: Where = { kind: 'DIRECTIVE', type: `@${name}`, pointer: `/directives/${seg(name)}` };
    if (!o) return this.add('directive-added', 'info', `Directive ${full} defined`, w, undefined, n!.pos);
    if (!n) return this.add('directive-removed', 'error', `Directive ${full} removed`, w, o.pos, undefined, this.sameFile(o.pos));
    for (const l of o.locations) if (!n.locations.includes(l)) this.add('directive-location-removed', 'error', `Directive ${full} can no longer be used on ${code(l)}`, { ...w, pointer: `${w.pointer}/locations/${l}` }, o.pos, n.pos);
    for (const l of n.locations) if (!o.locations.includes(l)) this.add('directive-location-added', 'info', `Directive ${full} can now be used on ${code(l)}`, { ...w, pointer: `${w.pointer}/locations/${l}` }, o.pos, n.pos);
    if (o.repeatable !== n.repeatable && this.lacks('repeatable')) this.skip('repeatable');
    else if (o.repeatable && !n.repeatable) this.add('directive-repeatable-removed', 'error', `Directive ${full} is no longer repeatable`, { ...w, pointer: `${w.pointer}/repeatable` }, o.pos, n.pos);
    else if (!o.repeatable && n.repeatable) this.add('directive-repeatable-added', 'info', `Directive ${full} is now repeatable`, { ...w, pointer: `${w.pointer}/repeatable` }, o.pos, n.pos);
    this.description('directive-description-changed', `Directive ${full}`, o.description, n.description, w, o.pos, n.pos);
    this.inputValues('directive-argument', o.args, n.args, (a) => `${a} of directive ${full}`, w, `${w.pointer}/args`, undefined, n.pos);
  }

  // --- shared ----------------------------------------------------------------------------

  /**
   * Arguments, input fields and directive arguments: what the client sends. `label` words
   * one of them for a message: "`first` of `Query.users`", or the input field's own name.
   */
  private inputValues(prefix: InputPrefix, o: Map<string, InputValue>, n: Map<string, InputValue>, label: (name: string) => string, w: Where, pointer: string, owner: string | undefined, parent: Pos | undefined) {
    // An introspection result without `isDeprecated` on input values leaves deprecated ones out.
    const hidden = this.lacks('inputDeprecation');
    const noun = prefix === 'argument' ? 'Argument' : prefix === 'input-field' ? 'Input field' : 'Argument';
    const names = new Set([...o.keys(), ...n.keys()]);
    for (const name of names) {
      const ov = o.get(name);
      const nv = n.get(name);
      const what = owner ? `${noun} ${code(`${owner}.${name}`)}` : `${noun} ${label(code(name))}`;
      const wv: Where = { ...w, field: w.field ?? (owner ? name : undefined), pointer: `${pointer}/${seg(name)}` };
      const id = (rule: string) => inputId(prefix, rule);
      if (!ov && nv!.deprecated && this.a.lacks.has('inputDeprecation')) {
        this.skip('inputDeprecation');
        continue;
      }
      if (!nv && ov!.deprecated && this.b.lacks.has('inputDeprecation')) {
        this.skip('inputDeprecation');
        continue;
      }
      if (!nv && this.b.lacks.has('inputDeprecation')) {
        // The new result leaves deprecated values out: this one may only have been deprecated.
        this.skip('inputDeprecation');
        this.add(id('removed'), 'warning', `${what} removed, or deprecated: the new introspection result leaves deprecated ${prefix === 'input-field' ? 'input fields' : 'arguments'} out`, wv, ov!.pos, undefined, parent);
        continue;
      }
      if (!ov) {
        const v = nv!;
        const required = v.type.endsWith('!') && v.default === undefined;
        if (required) this.add(id('added-required'), 'error', `Required ${what.charAt(0).toLowerCase() + what.slice(1)} added: ${code(v.type)}`, wv, undefined, v.pos);
        else if (v.default !== undefined) this.add(id('added'), 'warning', `${what} added with default ${code(v.default)}: the server now applies it for clients that don't send it`, wv, undefined, v.pos);
        else this.add(id('added'), 'info', `${what} added: ${code(v.type)}${deprecation(v.deprecated)}`, wv, undefined, v.pos);
        continue;
      }
      if (!nv) {
        if (ov.deprecated) this.add(id('deprecated-removed'), 'warning', `Deprecated ${what.charAt(0).toLowerCase() + what.slice(1)} removed${deprecation(ov.deprecated)}`, wv, ov.pos, undefined, parent);
        else this.add(id('removed'), 'error', `${what} removed`, wv, ov.pos, undefined, parent);
        continue;
      }
      const t = compareTypeRefs(ov.type, nv.type, 'input');
      const types = `${code(ov.type)} → ${code(nv.type)}`;
      const requiredOld = ov.type.endsWith('!') && ov.default === undefined;
      const requiredNew = nv.type.endsWith('!') && nv.default === undefined;
      let defaultsDone = false;
      if (t.result === 'changed') this.add(id('type-changed'), 'error', `${what} changed type: ${types}`, wv, ov.pos, nv.pos);
      else if (!requiredOld && requiredNew) {
        // Became required: through the type, through losing its default, or both.
        const how = t.topTightened ? `${types}${ov.default !== undefined ? `, default ${code(ov.default)} removed` : ''}` : `default ${code(ov.default)} removed from ${code(nv.type)}`;
        this.add(id('became-required'), 'error', `${what} became required: ${how}`, wv, ov.pos, nv.pos);
        defaultsDone = true;
      } else if (t.result === 'breaking') {
        const withDefault = t.topTightened && nv.default !== undefined && ov.default === undefined;
        this.add(id('became-non-null'), withDefault ? 'warning' : 'error', `${what} ${t.topTightened ? 'became non-null' : `no longer accepts ${code('null')} items`}: ${types}${withDefault ? `, with default ${code(nv.default)} (clients sending ${code('null')} break)` : ''}`, wv, ov.pos, nv.pos);
        if (withDefault) defaultsDone = true;
      } else if (t.result === 'safe') this.add(id('became-nullable'), 'info', `${what} ${t.topLoosened ? 'became nullable' : `now accepts ${code('null')} items`}: ${types}`, wv, ov.pos, nv.pos);
      if (!defaultsDone && this.defaultKey(ov, this.a) !== this.defaultKey(nv, this.b)) {
        if (ov.default === undefined) {
          // A value that was required was always sent: a default never applies to those clients.
          if (requiredOld) this.add(id('default-added'), 'info', `Default ${code(nv.default)} added to ${what.charAt(0).toLowerCase() + what.slice(1)}: it is no longer required`, wv, ov.pos, nv.pos);
          else this.add(id('default-added'), 'warning', `Default ${code(nv.default)} added to ${what.charAt(0).toLowerCase() + what.slice(1)}: the server now applies it for clients that don't send it`, wv, ov.pos, nv.pos);
        }
        else if (nv.default === undefined) this.add(id('default-removed'), 'warning', `Default ${code(ov.default)} of ${what.charAt(0).toLowerCase() + what.slice(1)} removed: clients that don't send it now send ${code('null')}`, wv, ov.pos, nv.pos);
        else this.add(id('default-changed'), 'warning', `Default of ${what.charAt(0).toLowerCase() + what.slice(1)} changed: ${code(ov.default)} → ${code(nv.default)}`, wv, ov.pos, nv.pos);
      }
      if (hidden && (!!ov.deprecated !== !!nv.deprecated || ov.deprecated?.reason !== nv.deprecated?.reason)) this.skip('inputDeprecation');
      else this.deprecated(prefix, what, ov.deprecated, nv.deprecated, wv, ov.pos, nv.pos);
      this.description(id('description-changed'), what, ov.description, nv.description, wv, ov.pos, nv.pos);
      this.usage(ov.directives, nv.directives, what.charAt(0).toLowerCase() + what.slice(1), wv, ov.pos, nv.pos);
    }
  }

  /**
   * A default as the server coerces it, so that the same value written two ways is no
   * change: `2.0` and `2` for a Float, `1` and `[1]` for a list (code-first servers'
   * introspection prints them so).
   */
  private defaultKey(v: InputValue, s: Schema): string | undefined {
    return v.defaultLit === undefined ? undefined : coerced(v.defaultLit, v.type, s, 0);
  }

  private deprecated(prefix: string, what: string, o: { reason?: string } | undefined, n: { reason?: string } | undefined, w: Where, op?: Pos, np?: Pos) {
    if (!o && n) this.add(`${prefix}-deprecated`, 'info', `${what} deprecated${n.reason ? `: ${code(n.reason)}` : ''}`, w, op, np);
    else if (o && !n) this.add(`${prefix}-deprecation-removed`, 'info', `${what} is no longer deprecated`, w, op, np);
    else if (o && n && o.reason !== n.reason) this.add(`${prefix}-deprecation-reason-changed`, 'info', `Deprecation reason of ${what.charAt(0).toLowerCase() + what.slice(1)} changed: ${code(o.reason ?? 'No longer supported')} → ${code(n.reason ?? 'No longer supported')}`, w, op, np);
  }

  /** Whitespace is not compared: an SDL printer re-wraps descriptions at 80 columns. */
  private description(id: string, what: string, o: string | undefined, n: string | undefined, w: Where, op?: Pos, np?: Pos) {
    const norm = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim();
    if (norm(o) === norm(n)) return;
    const how = !norm(o) ? 'added' : !norm(n) ? 'removed' : 'changed';
    this.add(id, 'info', `Description of ${what.charAt(0).toLowerCase() + what.slice(1)} ${how}`, { ...w, pointer: `${w.pointer}/description` }, op, np);
  }

  /** Applied directives other than `@deprecated`, `@specifiedBy` and `@oneOf`: federation's, auth, custom. */
  private usage(o: Directive[], n: Directive[], on: string, w: Where, op?: Pos, np?: Pos) {
    if (!o.length && !n.length) return;
    const show = (d: Directive) => `@${d.name}${d.args.size ? `(${[...d.args].map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}`;
    const key = (d: Directive) => `${d.name}|${[...d.args].sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => `${k}=${v}`).join('&')}`;
    const byName = (ds: Directive[]) => {
      const m = new Map<string, Directive[]>();
      for (const d of ds) m.set(d.name, [...(m.get(d.name) ?? []), d]);
      return m;
    };
    const om = byName(o);
    const nm = byName(n);
    for (const name of new Set([...om.keys(), ...nm.keys()])) {
      const os = om.get(name) ?? [];
      const ns = nm.get(name) ?? [];
      const wd: Where = { ...w, pointer: `${w.pointer}/directives/${seg(name)}` };
      // The same uses in another order are no change: take out the ones on both sides first.
      const left = [...ns];
      const gone: Directive[] = [];
      for (const d of os) {
        const i = left.findIndex((x) => key(x) === key(d));
        if (i >= 0) left.splice(i, 1);
        else gone.push(d);
      }
      // As many left on each side: paired up in order, their arguments changed; else added / removed.
      if (gone.length === left.length) {
        for (let i = 0; i < gone.length; i++) this.add('directive-usage-changed', 'info', `${code(show(gone[i]))} on ${on} is now ${code(show(left[i]))}`, wd, gone[i].pos ?? op, left[i].pos ?? np);
        continue;
      }
      for (const d of gone) this.add('directive-usage-removed', 'info', `${code(show(d))} removed from ${on}`, wd, d.pos ?? op, np);
      for (const d of left) this.add('directive-usage-added', 'info', `${code(show(d))} added to ${on}`, wd, op, d.pos ?? np);
    }
  }
}

export function compareSchemas(a: Schema, b: Schema): Change[] {
  return new Differ(a, b).run();
}

/** The changes, and why some differences were not compared. */
export function diffSchemas(a: Schema, b: Schema): { changes: Change[]; warnings: string[] } {
  const d = new Differ(a, b);
  const changes = d.run();
  return { changes, warnings: d.warnings() };
}

/** A value as SDL text after input coercion against its type; see `defaultKey`. */
function coerced(l: Lit, type: string, s: Schema, depth: number): string {
  if (depth > 64) return JSON.stringify(l);
  const t = type.endsWith('!') ? type.slice(0, -1) : type;
  const list = t.startsWith('[') && t.endsWith(']');
  const item = list ? t.slice(1, -1) : t;
  if (Array.isArray(l)) return `[${l.map((x) => coerced(x, item, s, depth + 1)).join(', ')}]`;
  // A single value where a list is expected is a list of one.
  if (list) return l === 'null' ? 'null' : `[${coerced(l, item, s, depth + 1)}]`;
  if (typeof l === 'string') return l;
  if ('num' in l) {
    const n = Number(l.num);
    return (t === 'Float' || t === 'Int') && Number.isFinite(n) ? String(n) : l.num;
  }
  const def = s.types.get(t);
  const fields = def?.kind === 'INPUT_OBJECT' ? def.inputFields : undefined;
  // The server fills in the input fields left out that have a default: `{}` and `{f: 3}` are
  // the same value when `f` defaults to 3.
  const entries = [...l.obj];
  if (fields) for (const f of fields.values()) if (f.defaultLit !== undefined && !entries.some(([k]) => k === f.name)) entries.push([f.name, f.defaultLit]);
  entries.sort(([x], [y]) => x.localeCompare(y));
  return `{${entries.map(([k, v]) => `${k}: ${coerced(v, fields?.get(k)?.type ?? '', s, depth + 1)}`).join(', ')}}`;
}

export { DEFAULT_ROOTS };
export type { RootOp };
