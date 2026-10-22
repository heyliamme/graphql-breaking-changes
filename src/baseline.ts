import * as vscode from 'vscode';
import { applyPolicy, atLeast, looksLikeSchema, type Change, type Side } from './core';
import { GitUnavailable, missingAtRef, repoFor, validRef, type Repo } from './git';
import { Superseded, type Runner } from './runner';
import { baseRef, LIVE_LIMIT, policy, problemsLevel, schemaGlob, SECTION, sizeOf } from './settings';
import { fromDocument, fromGit, mainSchemaOf, type SchemaSource } from './sources';

const SEVERITY: Record<Change['level'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

interface Shown {
  diag: vscode.Diagnostic;
  /** None for the note that the check couldn't run. */
  change?: Change;
}

const SCHEMA_PATH = /\.(graphqls?|gql|json)$/i;

/** Files that aren't called `.graphql` need a root type or a schema block to count. */
export const strictFor = (uri: vscode.Uri, languageId?: string) => !(/\.(graphqls?|gql)$/i.test(uri.path) || languageId === 'graphql');

const side = (s: SchemaSource): Side => ({ text: s.text, path: s.path, files: s.files });

/**
 * The `baseRef` check: breaking changes since a Git ref, in the Problems panel, for every
 * open schema file. A change in another file of a split schema is shown on that file.
 */
export class Baseline implements vscode.CodeActionProvider {
  private collection = vscode.languages.createDiagnosticCollection('graphqlBreakingChanges');
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = new Map<string, number>();
  /** Per checked schema (by URI), the problems it found, by the file they are in. */
  private found = new Map<string, Map<string, Shown[]>>();
  /** Per file of a split schema (by URI), the open schemas that merge it. */
  private readers = new Map<string, Set<string>>();
  /** Repositories already watched, by root: `repoFor` returns a new wrapper each time. */
  private watched = new Set<string>();
  /** Per repository root, the commits HEAD and each baseline ref were at when last checked. */
  private commits = new Map<string, string>();
  private refsInUse = new Map<string, Set<string>>();
  private disposables: vscode.Disposable[] = [this.collection];
  private warnedRef = new Set<string>();
  /**
   * The baseline side by commit, file and file pattern: it can't change while people type,
   * so it is read from Git once, not after every pause.
   */
  private bases = new Map<string, Promise<SchemaSource>>();
  /** Per checked document (by URI), the main file of the schema it was checked as. */
  private checkedAs = new Map<string, vscode.Uri>();

  constructor(private runner: Runner) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => this.edited(e.document)),
      vscode.workspace.onDidSaveTextDocument((d) => this.saved(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.forget(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration(SECTION) && this.all()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.all()),
      vscode.languages.registerCodeActionsProvider([{ scheme: 'file', language: 'graphql' }, { scheme: 'file', language: 'json' }, { scheme: 'file', language: 'jsonc' }, { scheme: 'file', pattern: '**/*.{graphql,graphqls,gql}' }], this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
    );
    this.all();
  }

  all() {
    for (const d of vscode.workspace.textDocuments) this.schedule(d, 0);
  }

  /** Typing: checked again once it pauses, for schemas small enough; and the schemas that merge this file. */
  private edited(doc: vscode.TextDocument) {
    if (doc.uri.scheme !== 'file') return;
    const live = sizeOf(doc) <= LIVE_LIMIT;
    if (live) this.schedule(doc, 800);
    for (const r of this.dependents(doc)) if (live || sizeOf(r) <= LIVE_LIMIT) this.schedule(r, 800);
  }

  private saved(doc: vscode.TextDocument) {
    this.schedule(doc, 0);
    for (const r of this.dependents(doc)) this.schedule(r, 0);
  }

  /** The open schemas that merge a file. */
  private dependents(doc: vscode.TextDocument): vscode.TextDocument[] {
    const of = this.readers.get(doc.uri.toString());
    if (!of?.size) return [];
    return vscode.workspace.textDocuments.filter((d) => d !== doc && of.has(d.uri.toString()));
  }

  /** A document closed: the problems its own check found go, not those other schemas found in it. */
  private forget(uri: vscode.Uri) {
    const key = uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.clear(key);
  }

  /** Removes what a schema's check found, everywhere it was shown. */
  private clear(key: string) {
    const was = this.found.get(key);
    this.found.delete(key);
    this.checkedAs.delete(key);
    for (const files of this.readers.values()) files.delete(key);
    if (was) for (const file of was.keys()) this.publish(file);
  }

  /**
   * Shows every problem found in a file, by whichever schema found it. The files of a
   * split schema each find the same changes: a problem is shown once.
   */
  private publish(file: string) {
    const all: vscode.Diagnostic[] = [];
    const seen = new Set<string>();
    for (const byFile of this.found.values())
      for (const s of byFile.get(file) ?? []) {
        const k = `${s.diag.code}|${s.diag.range.start.line}|${s.diag.range.start.character}|${s.diag.message}`;
        if (!seen.has(k)) {
          seen.add(k);
          all.push(s.diag);
        }
      }
    if (all.length) this.collection.set(vscode.Uri.parse(file), all);
    else this.collection.delete(vscode.Uri.parse(file));
  }

  private schedule(doc: vscode.TextDocument, delay: number) {
    if (doc.uri.scheme !== 'file' || !(SCHEMA_PATH.test(doc.uri.path) || doc.languageId === 'graphql')) return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.check(doc);
      }, delay),
    );
  }

  private async check(doc: vscode.TextDocument) {
    const key = doc.uri.toString();
    const seq = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, seq);
    const stale = () => seq !== this.seq.get(key) || doc.isClosed;
    const ref = baseRef(doc.uri);
    if (!ref || !vscode.workspace.isTrusted || doc.isClosed || !looksLikeSchema(doc.getText(), strictFor(doc.uri, doc.languageId))) {
      this.clear(key);
      return;
    }
    if (!validRef(ref)) {
      this.warnOnce(ref, `GraphQL Breaking Changes: "${ref}" in ${SECTION}.baseRef is not a branch, tag or commit.`);
      this.clear(key);
      return;
    }
    let changes: Change[];
    let files: string[];
    let partly: string[];
    try {
      const repo = await repoFor(doc.uri);
      this.watch(repo, ref);
      // A ref that names nothing (a typo, a branch not fetched yet) must not look like "no changes".
      const commit = await repo.resolve(ref);
      if (!commit) {
        this.warnOnce(ref, `GraphQL Breaking Changes: "${ref}" in ${SECTION}.baseRef is not a branch, tag or commit in ${repo.root.path.split('/').pop()}, so open schemas are not checked. Fetch it or fix the setting.`);
        if (!stale()) this.clear(key);
        return;
      }
      // A part of a split schema is checked as the whole schema its main file reads: on its
      // own, a definition moved out of its folder would look removed.
      const schema = (await mainSchemaOf(doc.uri, doc.getText())) ?? doc.uri;
      this.checkedAs.set(key, schema);
      const current = await fromDocument(schema);
      if (stale()) return;
      let base: SchemaSource;
      try {
        // When only some files were read on disk, the same ones are read at the ref.
        base = await this.baseAt(commit, schema, ref, repo, current.partial);
      } catch (e) {
        // A schema that is new since the baseline has nothing to break.
        if (missingAtRef(e)) {
          if (!stale()) this.clear(key);
        } else if (!stale()) this.notChecked(key, doc, ref, `couldn't read ${schema.path.split('/').pop()} at ${ref} (${e instanceof Error ? e.message : String(e)})`);
        return;
      }
      if (stale()) return;
      const r = await this.runner.run(`baseline:${key}`, side(base), schema.toString() === key ? { ...side(current), text: doc.getText() } : side(current));
      if (r.errors.old || r.errors.new) {
        // Not "no breaking changes": say that nothing was compared.
        const e = (r.errors.new ?? r.errors.old)!;
        const which = r.errors.new ? 'the schema' : `the schema at ${ref}`;
        if (!stale()) this.notChecked(key, doc, ref, `${which} doesn't parse: ${e.message}${e.line !== undefined ? ` (line ${e.line + 1}${e.file && e.file !== doc.uri.path ? ` of ${e.file.split('/').pop()}` : ''})` : ''}`);
        return;
      }
      changes = applyPolicy(r.changes, policy(doc.uri));
      files = r.files.new;
      partly = [...new Set([...(current.warnings ?? []), ...(base.warnings ?? [])])];
    } catch (e) {
      if (e instanceof Superseded) return;
      if (!(e instanceof GitUnavailable)) console.error(e);
      if (!stale()) this.notChecked(key, doc, ref, e instanceof Error ? e.message : String(e));
      return;
    }
    if (stale()) return;

    // Which files this schema merges, to check it again when one of them changes.
    for (const set of this.readers.values()) set.delete(key);
    for (const f of files) {
      if (f === doc.uri.path) continue;
      const u = doc.uri.with({ path: f }).toString();
      (this.readers.get(u) ?? this.readers.set(u, new Set()).get(u)!).add(key);
    }

    const min = problemsLevel(doc.uri);
    const byFile = new Map<string, Change[]>();
    for (const c of changes) {
      // A removal has no place in the new schema: it shows where its closest surviving parent is.
      const at = c.new ?? c.anchor;
      if (c.ignored !== undefined || !atLeast(c.level, min) || !at || !files.includes(at.file)) continue;
      const u = doc.uri.with({ path: at.file }).toString();
      (byFile.get(u) ?? byFile.set(u, []).get(u)!).push(c);
    }
    const before = [...(this.found.get(key)?.keys() ?? [])];
    const result = new Map<string, Shown[]>();
    for (const [file, mine] of byFile) result.set(file, this.diagnostics(file === key ? doc : undefined, mine, ref));
    if (partly.length) {
      // Not every file of the split schema was compared: say so, beside what was found.
      const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), `Only part of the split schema was checked for breaking changes since ${ref}: ${strip(partly[0]).replace(/\.$/, '')}.`, vscode.DiagnosticSeverity.Information);
      d.source = `since ${ref}`;
      d.code = 'partly-checked';
      result.set(key, [{ diag: d }, ...(result.get(key) ?? [])]);
    }
    this.found.set(key, result);
    for (const file of new Set([...before, ...result.keys()])) this.publish(file);
  }

  /** Problems for the changes found in one file. */
  private diagnostics(doc: vscode.TextDocument | undefined, mine: Change[], ref: string): Shown[] {
    const where = (c: Change) => (c.new ?? c.anchor)!;
    const file = mine[0] && where(mine[0]).file;
    const textDoc = doc ?? vscode.workspace.textDocuments.find((d) => d.uri.path === file && d.uri.scheme === 'file');
    const shown: Shown[] = [];
    for (const c of mine) {
      const loc = where(c);
      let range: vscode.Range;
      if (textDoc) {
        const line = Math.min(loc.line, textDoc.lineCount - 1);
        const text = textDoc.lineAt(line).text;
        const start = Math.min(loc.col, text.length);
        // The name at the position, else the rest of the line.
        const name = text.slice(start).match(/^[_A-Za-z]\w*/)?.[0];
        range = new vscode.Range(line, start, line, name ? start + name.length : Math.max(start, text.trimEnd().length));
      } else range = new vscode.Range(loc.line, loc.col, loc.line, loc.col);
      const d = new vscode.Diagnostic(range, strip(c.message), SEVERITY[c.level]);
      d.source = `since ${ref}`;
      d.code = c.id;
      shown.push({ diag: d, change: c });
    }
    return shown;
  }

  /**
   * Checking out, committing or fetching can move what HEAD or the baseline ref point at;
   * then every open schema is checked again. Git also reports a status after every save,
   * which moves nothing: those are skipped.
   */
  private watch(repo: Repo, ref: string) {
    const root = repo.root.toString();
    (this.refsInUse.get(root) ?? this.refsInUse.set(root, new Set()).get(root)!).add(ref);
    if (this.watched.has(root) || !repo.onDidChange) return;
    this.watched.add(root);
    const where = async () => {
      const refs = ['HEAD', ...(this.refsInUse.get(root) ?? [])];
      return (await Promise.all(refs.map(async (r) => `${r}=${(await repo.resolve(r).catch(() => undefined)) ?? ''}`))).join(' ');
    };
    void where().then((w) => this.commits.set(root, w));
    let t: ReturnType<typeof setTimeout> | undefined;
    this.disposables.push(
      repo.onDidChange(() => {
        clearTimeout(t);
        t = setTimeout(async () => {
          const now = await where();
          if (now === this.commits.get(root)) return;
          this.commits.set(root, now);
          this.all();
        }, 1500);
      }),
    );
  }

  /** The baseline side, read from Git once per commit, file and pattern. */
  private baseAt(commit: string, file: vscode.Uri, ref: string, repo: Repo, only?: string[]): Promise<SchemaSource> {
    const k = `${commit}|${file.toString()}|${schemaGlob(file)}${only ? `|${only.join('\0')}` : ''}`;
    let p = this.bases.get(k);
    if (!p) {
      p = fromGit(file, ref, repo, only && new Set(only));
      this.bases.set(k, p);
      // A file missing at a commit stays missing; another failure (Git busy, a blob not
      // fetched yet) may not, and is tried again.
      p.catch((e) => missingAtRef(e) || this.bases.delete(k));
      // A few schemas, a few refs: the oldest go first.
      while (this.bases.size > 32) this.bases.delete(this.bases.keys().next().value!);
    }
    return p;
  }

  /**
   * The check couldn't run: one note on the schema's first line, so that an empty Problems
   * panel never stands for "no breaking changes" when nothing was compared.
   */
  private notChecked(key: string, doc: vscode.TextDocument, ref: string, why: string) {
    const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), `Not checked for breaking changes since ${ref}: ${strip(why).replace(/\.$/, '')}.`, vscode.DiagnosticSeverity.Information);
    d.source = `since ${ref}`;
    d.code = 'not-checked';
    const was = [...(this.found.get(key)?.keys() ?? [])];
    this.found.set(key, new Map([[key, [{ diag: d }]]]));
    for (const file of new Set([...was, key])) this.publish(file);
  }

  private warnOnce(ref: string, msg: string) {
    if (this.warnedRef.has(ref)) return;
    this.warnedRef.add(ref);
    void vscode.window.showWarningMessage(msg);
  }

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const file = doc.uri.toString();
    const shown: Array<{ schema: string; s: Shown }> = [];
    for (const [schema, byFile] of this.found) for (const s of byFile.get(file) ?? []) shown.push({ schema, s });
    if (!shown.length) return [];
    const actions: vscode.CodeAction[] = [];
    for (const d of ctx.diagnostics) {
      const hit = shown.find((x) => x.s.change && x.s.diag.code === d.code && x.s.diag.message === d.message && x.s.diag.range.isEqual(d.range));
      if (!hit) continue;
      const c = hit.s.change!;
      // A part of a split schema was checked as its main file: the report is that file's.
      const schema = this.checkedAs.get(hit.schema) ?? vscode.Uri.parse(hit.schema);
      const ignore = new vscode.CodeAction(`Ignore ${c.id}…`, vscode.CodeActionKind.QuickFix);
      ignore.diagnostics = [d];
      ignore.command = { command: 'graphqlBreakingChanges.ignoreChange', title: 'Ignore', arguments: [c, schema] };
      const report = new vscode.CodeAction('Show all schema changes since the baseline', vscode.CodeActionKind.QuickFix);
      report.diagnostics = [d];
      report.command = { command: 'graphqlBreakingChanges.showBaselineReport', title: 'Show', arguments: [schema] };
      actions.push(report, ignore);
    }
    return actions;
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

/** Backticks read fine in the report, less so in the Problems panel. */
const strip = (s: string) => s.replace(/`/g, "'");
