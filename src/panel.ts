import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { applyPolicy, count, escapeName, mdText, toMarkdown, toReleaseNotes, type Change, type IgnoreRule, type Result, type Side } from './core';
import type { FromWebview, Report, SideName, ToWebview, ViewState } from './protocol';
import { Superseded, type Runner } from './runner';
import { addIgnore, LIVE_LIMIT, policy, SECTION, sizeOf } from './settings';
import { distinguish, fromRestore, unrestored, type Restore, type SchemaSource } from './sources';

export const VIEW_TYPE = 'graphqlBreakingChanges';

interface Saved {
  old?: Restore;
  new?: Restore;
  view?: ViewState;
}

const sideOf = (s: SchemaSource): Side => ({ text: s.text, path: s.path, files: s.files, warnings: s.warnings });

export class ReportPanel {
  private static open = new Set<ReportPanel>();
  private static ids = 0;
  /** Runs the comparisons; set when the extension starts. */
  static runner: Runner;
  private id = ++ReportPanel.ids;
  private panel: vscode.WebviewPanel;
  private disposed = false;
  /** The settings that apply: those of the file the comparison started from, whichever side it is on. */
  private scope?: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private result?: Result;
  private changes: Change[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private seq = 0;
  /** Counts replacements of the sides (a swap, a new comparison), so that slower reloads don't undo them. */
  private gen = 0;
  /** The report the view shows: messages about an older one are dropped. */
  private reportId = 0;
  private ready = false;
  private view?: ViewState;

  /** Opens a report, or brings back the one already showing these two sides. */
  static show(extensionUri: vscode.Uri, oldSide: SchemaSource, newSide: SchemaSource) {
    distinguish(oldSide, newSide);
    const key = JSON.stringify([oldSide.restore, newSide.restore]);
    for (const p of ReportPanel.open) {
      if (JSON.stringify([p.sides.old.restore, p.sides.new.restore]) === key) {
        p.setSides({ old: oldSide, new: newSide });
        p.panel.reveal();
        void p.update();
        return p;
      }
    }
    return new ReportPanel(extensionUri, { old: oldSide, new: newSide });
  }

  static async revive(extensionUri: vscode.Uri, panel: vscode.WebviewPanel, state: unknown) {
    // The webview keeps { persist: { old, new }, view } (see webview/main.ts).
    const kept = (state ?? {}) as { persist?: Saved; view?: ViewState };
    const saved: Saved = { ...(kept.persist ?? {}), view: kept.view };
    if (!saved.old || !saved.new) {
      panel.dispose();
      return undefined;
    }
    // A side that can't be read now (Restricted Mode, a document not open yet) keeps the
    // report: it says why, and Refresh, or trusting the folder, tries again.
    const back = async (r: Restore) => {
      try {
        return await fromRestore(r);
      } catch (e) {
        return unrestored(r, e instanceof Error ? e.message : String(e));
      }
    };
    const [o, n] = await Promise.all([back(saved.old), back(saved.new)]);
    const p = new ReportPanel(extensionUri, { old: o, new: n }, panel);
    p.view = saved.view;
    return p;
  }

  /** The open reports, to refresh after settings change. */
  static all() {
    return [...ReportPanel.open];
  }

  private constructor(
    private extensionUri: vscode.Uri,
    private sides: Record<SideName, SchemaSource>,
    existing?: vscode.WebviewPanel,
  ) {
    distinguish(sides.old, sides.new);
    this.scope = sides.new.scope ?? sides.old.scope;
    const options = { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')] };
    this.panel = existing ?? vscode.window.createWebviewPanel(VIEW_TYPE, this.title(), vscode.ViewColumn.Active, options);
    if (existing) existing.webview.options = options;
    this.panel.title = this.title();
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(
      (m: FromWebview) =>
        this.onMessage(m).catch((e) => {
          if (!this.disposed) vscode.window.showErrorMessage(`GraphQL Breaking Changes: ${e instanceof Error ? e.message : String(e)}`);
        }),
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    vscode.workspace.onDidChangeTextDocument((e) => this.onDocument(e.document, false), null, this.disposables);
    vscode.workspace.onDidSaveTextDocument((d) => this.onDocument(d, true), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration(`${SECTION}.schemaFiles`)) void this.refresh();
        else if (e.affectsConfiguration(SECTION)) this.applyPolicy();
      },
      null,
      this.disposables,
    );
    // Trusting the folder brings in its ignore rules and its schema file pattern.
    vscode.workspace.onDidGrantWorkspaceTrust(() => void this.refresh(), null, this.disposables);
    ReportPanel.open.add(this);
    void this.update();
  }

  private title() {
    const { old: o, new: n } = this.sides;
    return `Schema changes: ${o.label} → ${n.label}`;
  }

  private post(m: ToWebview) {
    if (this.ready && !this.disposed) void this.panel.webview.postMessage(m);
  }

  /**
   * An edit to a side's document, or to another file of its split schema: compare again
   * once typing pauses (large schemas: when saved). The texts are read when the timer
   * fires, so edits to both sides, or a swap in between, are all taken in.
   */
  private onDocument(doc: vscode.TextDocument, saved: boolean) {
    const uri = doc.uri.toString();
    if (!(['old', 'new'] as const).some((s) => this.sides[s].watch.has(uri))) return;
    if (!saved && sizeOf(doc) > LIVE_LIMIT) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      for (const s of ['old', 'new'] as const) {
        const side = this.sides[s];
        const live = side.live?.toString();
        const d = live && vscode.workspace.textDocuments.find((x) => x.uri.toString() === live);
        const files = side.files.map((f) => {
          const open = vscode.workspace.textDocuments.find((x) => x.uri.scheme === side.live?.scheme && x.uri.path === f.path);
          return open ? { path: f.path, text: open.getText() } : f;
        });
        this.sides[s] = { ...side, text: d ? d.getText() : side.text, files };
      }
      void this.update();
    }, saved ? 0 : 400);
  }

  /** Re-runs the comparison. Later runs win over slower earlier ones. */
  async update() {
    if (this.disposed) return;
    const seq = ++this.seq;
    const { old: o, new: n } = this.sides;
    this.panel.title = this.title();
    let result: Result;
    try {
      if (o.failed || n.failed) {
        const err = (s: SchemaSource) => (s.failed ? { message: s.failed, file: s.path } : undefined);
        result = { changes: [], errors: { old: err(o), new: err(n) }, warnings: [], files: { old: [], new: [] }, info: {}, ms: 0 };
      } else result = await ReportPanel.runner.run(`panel:${this.id}`, sideOf(o), sideOf(n));
    } catch (e) {
      if (e instanceof Superseded) return;
      result = { changes: [], errors: { new: { message: `The comparison failed: ${e instanceof Error ? e.message : String(e)}`, file: n.path } }, warnings: [], files: { old: [], new: [] }, info: {}, ms: 0 };
    }
    if (seq !== this.seq || this.disposed) return;
    this.result = result;
    this.applyPolicy();
  }

  private applyPolicy() {
    const r = this.result;
    if (!r || this.disposed) return;
    const p = policy(this.scope);
    this.changes = applyPolicy(r.changes, p);
    const report: Report = {
      id: ++this.reportId,
      old: { label: this.sides.old.label, detail: this.sides.old.detail, path: this.sides.old.path, info: r.info.old, error: r.errors.old },
      new: { label: this.sides.new.label, detail: this.sides.new.detail, path: this.sides.new.path, info: r.info.new, error: r.errors.new },
      changes: this.changes,
      counts: count(this.changes),
      warnings: r.warnings,
      ms: r.ms,
      strict: p.warningsAsErrors,
    };
    this.post({ type: 'report', report });
    this.saveState();
  }

  private saveState() {
    this.post({ type: 'persist', state: { old: this.sides.old.restore, new: this.sides.new.restore } satisfies Saved });
  }

  /** New sides: what was shown for the old ones no longer applies. */
  private setSides(sides: Record<SideName, SchemaSource>) {
    this.gen++;
    // Messages about the report shown so far name the old sides: from now on they are dropped.
    this.reportId++;
    this.sides = sides;
    this.result = undefined;
    this.changes = [];
  }

  /** Reads both sides again (the file pattern or trust changed, or the button was pressed). */
  private async refresh() {
    this.post({ type: 'loading' });
    const gen = this.gen;
    const { old: before } = this.sides;
    try {
      const [o, n] = await Promise.all([this.sides.old.reload(), this.sides.new.reload()]);
      if (this.disposed) return;
      if (this.gen === gen || this.sides.old === before) this.setSides({ old: o, new: n });
      // Swapped while reading: the new texts, in the order now shown.
      else if (this.sides.new === before) this.setSides({ old: n, new: o });
      // Replaced by another comparison of the same files: that one stands.
      else return void this.update();
      distinguish(this.sides.old, this.sides.new);
    } catch (e) {
      if (this.disposed) return;
      vscode.window.showErrorMessage(`GraphQL Breaking Changes: ${e instanceof Error ? e.message : String(e)}`);
    }
    void this.update();
  }

  private async onMessage(m: FromWebview) {
    // About a report the view no longer shows (a swap or an update came in between): its
    // indexes and sides would name other changes and other files now.
    if ('report' in m && m.report !== this.reportId) return;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        if (this.view) this.post({ type: 'view', view: this.view });
        this.post({ type: 'loading' });
        if (this.result) this.applyPolicy();
        break;
      case 'open': {
        const uri = this.sides[m.side].uriFor(m.file);
        if (!uri) {
          vscode.window.showInformationMessage("This side can't be opened in an editor.");
          return;
        }
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const pos = new vscode.Position(m.line, m.col);
          const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
          await vscode.window.showTextDocument(doc, { viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos), preview: true });
        } catch (e) {
          vscode.window.showErrorMessage(`GraphQL Breaking Changes: couldn't open ${m.file} (${e instanceof Error ? e.message : String(e)}).`);
        }
        break;
      }
      case 'copyMarkdown': {
        if (!this.compared()) return;
        const md = toMarkdown(this.changes, `Schema changes: ${mdText(this.sides.old.label)} → ${mdText(this.sides.new.label)}`);
        await vscode.env.clipboard.writeText(md);
        vscode.window.setStatusBarMessage('$(check) Copied the changes as Markdown', 3000);
        break;
      }
      case 'releaseNotes': {
        if (!this.compared()) return;
        await openReleaseNotes(toReleaseNotes(this.changes, { from: this.sides.old.name, to: this.sides.new.name, schema: this.sides.new.label.replace(/ \(.*\)$/, '') }));
        break;
      }
      case 'ignore': {
        const c = this.changes[m.index];
        if (c) await promptIgnore(c, this.scope);
        break;
      }
      case 'swap':
        this.setSides({ old: this.sides.new, new: this.sides.old });
        this.post({ type: 'loading' });
        void this.update();
        break;
      case 'refresh':
        await this.refresh();
        break;
    }
  }

  /** Both sides were read and compared: there is something to copy. */
  private compared(): boolean {
    const r = this.result;
    if (r && !r.errors.old && !r.errors.new) return true;
    vscode.window.showInformationMessage(r ? 'Nothing was compared: one side could not be read.' : 'The comparison is still running.');
    return false;
  }

  private html() {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const asset = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', f));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; font-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('codicon.css')}">
<link rel="stylesheet" href="${asset('webview.css')}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    ReportPanel.open.delete(this);
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel.dispose();
  }
}

/** Asks how widely to ignore a change, then saves the rule to settings. */
export async function promptIgnore(of: Change | Change[], scope?: vscode.Uri) {
  type Item = vscode.QuickPickItem & { rule: IgnoreRule | string | Array<IgnoreRule | string> };
  const cs = Array.isArray(of) ? of : [of];
  const c = cs[0];
  if (!c) return;
  const items: Item[] = [];
  // Names as written in the schema, not patterns: a `*` in one matches only itself.
  const on = c.type ? (c.field ? `${c.type}.${c.field}` : c.type) : 'the schema';
  if (c.type) items.push({ label: 'This change', description: `${c.id} on ${on}`, rule: { id: c.id, type: escapeName(c.type), ...(c.field ? { field: escapeName(c.field) } : {}) } });
  items.push({ label: `Every ${c.id}`, description: 'anywhere in the schema', rule: c.id });
  if (c.type && c.field) items.push({ label: `Everything on ${on}`, description: 'any change to this field', rule: { type: escapeName(c.type), field: escapeName(c.field) } });
  if (c.type) items.push({ label: `Everything on ${c.type}`, description: `any change to this ${c.kind === 'DIRECTIVE' ? 'directive' : 'type'}`, rule: { type: escapeName(c.type) } });
  const pick = await vscode.window.showQuickPick(items, { title: 'Ignore which changes?', placeHolder: 'Ignored changes stay in the report, dimmed, and leave the counts and the Problems panel' });
  if (!pick) return;
  // In Restricted Mode the workspace's ignore rules are not applied: saying "added" there
  // would be a rule that does nothing.
  let user = false;
  if (!vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.length) {
    const choice = await vscode.window.showInformationMessage(
      "This folder is in Restricted Mode, so ignore rules in its settings aren't applied until you trust it. Add the rule to your user settings instead?",
      'Add to User Settings',
      'Manage Workspace Trust',
    );
    if (choice === 'Manage Workspace Trust') await vscode.commands.executeCommand('workbench.trust.manage');
    if (choice !== 'Add to User Settings') return;
    user = true;
  }
  let where: string;
  try {
    where = await addIgnore(pick.rule, scope, user);
  } catch (e) {
    vscode.window.showErrorMessage(`GraphQL Breaking Changes: the ignore rule was not added (${e instanceof Error ? e.message : String(e)}).`);
    return;
  }
  vscode.window.setStatusBarMessage(`$(check) Added to ${where} settings: ${SECTION}.ignore`, 4000);
}

/** Opens release notes in a new Markdown editor, to edit and copy. */
export async function openReleaseNotes(md: string) {
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
  await vscode.window.showTextDocument(doc, { preview: false });
}
